import fs from 'fs';
import path from 'path';
import { javaTooNewViolation, requiredJavaMajor } from '@mc-manager/shared';
import { detectServerType } from './server-type';

/**
 * Everything knowable about why a server will not work, before it is started.
 *
 * The failures this exists for share a shape: all of them are visible in the server's own
 * directory, all of them are decided before launch, and none of them says anything useful
 * afterwards. A Forge pack configured as Fabric boots into an empty vanilla world with a
 * clean log. A 1.12.2 pack on Java 17 dies inside LaunchWrapper naming neither. A world
 * left over from a bad boot survives the fix that was supposed to cure it.
 *
 * So they are checked up front, and each one carries the fix that resolves it rather than
 * an instruction to go and find it.
 */

export type FindingSeverity = 'block' | 'warn';

export interface PreflightFix {
  /** What the panel should do about it. */
  action: 'set-engine' | 'rescue-world';
  /** Button text, phrased as the thing it does. */
  label: string;
  serverType?: string;
  mcVersion?: string;
}

export interface PreflightFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  fix?: PreflightFix;
}

export interface PreflightInput {
  serverDir: string;
  /** What the panel believes, which is the thing being checked. */
  serverType?: string;
  mcVersion?: string;
  /** Newest JDK this node can reach, or null when it could not be determined. */
  availableJava?: number | null;
  /**
   * True when servers run as containers here. The image tag carries the JDK, so Docker
   * picks the right Java from the version by itself and the Java findings do not apply.
   */
  dockerMode?: boolean;
}

function countJars(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).length;
  } catch {
    return 0;
  }
}

/** Whether a world has already been generated here, which a loader change will not undo. */
export function hasGeneratedWorld(serverDir: string): boolean {
  // level.dat is the marker: a bare `world/` directory is created by plenty of things,
  // but only a server that actually booted and generated terrain writes this.
  return fs.existsSync(path.join(serverDir, 'world', 'level.dat'));
}

const LOADERS = ['FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'];

export function preflight(input: PreflightInput): PreflightFinding[] {
  const { serverDir, serverType, mcVersion, availableJava, dockerMode } = input;
  const findings: PreflightFinding[] = [];

  const configured = (serverType || '').toUpperCase();
  const detected = detectServerType(serverDir);
  const modCount = countJars(path.join(serverDir, 'mods'));

  /*
   * The loader the server will actually run once everything below is applied. Findings
   * further down reason about the corrected server, not the broken one — otherwise fixing
   * the loader would surface a Java problem that was there all along but unmentioned.
   */
  const effectiveLoader = detected.loader && modCount > 0 ? detected.loader : configured;
  const effectiveVersion =
    mcVersion && mcVersion !== 'LATEST' ? mcVersion : detected.version || mcVersion;

  // --- 1. The files say one loader, the panel says another ---
  if (LOADERS.includes(configured) && detected.loader && detected.loader !== configured && modCount > 0) {
    findings.push({
      id: 'loader-mismatch',
      severity: 'block',
      title: `This server is set to ${configured}, but its files are ${detected.loader}`,
      detail:
        `Found ${detected.evidence} alongside ${modCount} mods. Started as ${configured} it would load ` +
        `none of them, generate an ordinary Minecraft world, and report itself as running — which is ` +
        `why this is stopped here rather than left to look like it worked.`,
      fix: {
        action: 'set-engine',
        label: `Switch to ${detected.loader}${detected.version ? ` ${detected.version}` : ''}`,
        serverType: detected.loader,
        mcVersion: detected.version || undefined,
      },
    });
  }

  // --- 2. An old pack left on LATEST ---
  if ((!mcVersion || mcVersion === 'LATEST') && detected.version) {
    findings.push({
      id: 'version-latest',
      severity: 'block',
      title: `This server has no Minecraft version set, but its files are ${detected.version}`,
      detail:
        `LATEST resolves to the newest Minecraft release. The files here are ${detected.version} ` +
        `(from ${detected.evidence}), and the version also decides which Java the server gets — so ` +
        `leaving it at LATEST picks both the wrong game version and the wrong JVM.`,
      fix: {
        action: 'set-engine',
        label: `Set Minecraft ${detected.version}`,
        serverType: detected.loader || configured || undefined,
        mcVersion: detected.version,
      },
    });
  }

  // --- 3. Java, in both directions ---
  if (!dockerMode && availableJava != null) {
    const tooNew = javaTooNewViolation(effectiveVersion, effectiveLoader, availableJava);
    if (tooNew) {
      findings.push({
        id: 'java-too-new',
        severity: 'block',
        // No fix action: a JDK cannot be conjured, and picking a different Minecraft
        // version to suit the JVM would be the wrong way round.
        title: `This node's Java is too new for ${effectiveLoader} ${effectiveVersion}`,
        detail:
          `${tooNew} Install Java ${8} on this node, point JAVA_BIN at it, or host this server on a ` +
          `node that runs its servers as Docker containers — those pick the JDK from the version.`,
      });
    }

    const required = requiredJavaMajor(effectiveVersion);
    if (!tooNew && availableJava < required) {
      findings.push({
        id: 'java-too-old',
        severity: 'block',
        title: `This node's Java is too old for Minecraft ${effectiveVersion}`,
        detail:
          `Minecraft ${effectiveVersion} needs Java ${required} and this node has Java ${availableJava}. ` +
          `Install Java ${required} on this node, or move the server to one that has it.`,
      });
    }
  }

  /*
   * --- 4. A world that will outlive the fix ---
   *
   * Only raised alongside a loader or version change, because that is when it misleads.
   * Minecraft loads an existing world as-is; a pack whose terrain comes from its own mods
   * — a skyblock void, a custom dimension — generates it on first boot and never again.
   * So the corrected server starts, loads every mod, and drops the player into the plain
   * world the broken one made, which reads as the fix not having worked.
   */
  const configChanging = findings.some((f) => f.id === 'loader-mismatch' || f.id === 'version-latest');
  if (configChanging && hasGeneratedWorld(serverDir)) {
    findings.push({
      id: 'stale-world',
      severity: 'warn',
      title: 'A world already exists here, generated before this was fixed',
      detail:
        'Changing the loader does not regenerate it — Minecraft loads whatever world is there. If this ' +
        'pack builds its own world, setting the old one aside lets it do that on the next start. ' +
        'Nothing is deleted: it is renamed, and can be put back.',
      fix: { action: 'rescue-world', label: 'Set the old world aside' },
    });
  }

  return findings;
}

/** Whether anything found is bad enough to stop a start. */
export function blocks(findings: PreflightFinding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
