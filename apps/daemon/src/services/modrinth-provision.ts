import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';
import { resolveMrpackDetails, downloadModrinthFile } from './modrinth';
import { findMrpackRoot, materializeMrpack, MrpackLoader } from './mrpack';
import { provisioningManager } from './provisioning';

/**
 * Turns a Modrinth modpack slug into a runnable server directory.
 *
 * A .mrpack is not a server: it is a manifest listing mods to fetch, a set of overrides, and
 * the loader the pack expects. `materializeMrpack` already knows how to turn an *uploaded*
 * pack into a working server — this module supplies the missing front half, fetching the
 * pack straight from Modrinth so deploying from the browser reaches the same code path as
 * uploading the file by hand.
 *
 * Before this existed, creating a Modrinth server in process mode ran straight past the
 * modpack and provisioned a bare server: the slug was recorded and then never acted on.
 */

/** Written into the server directory once a pack is installed, and read back to stay idempotent. */
export const MODPACK_MARKER = '.craftcontrol-modpack.json';

export interface InstalledModpack {
  slug: string;
  versionId: string;
  versionNumber: string;
  name?: string;
  mcVersion?: string;
  loader: MrpackLoader;
  loaderVersion?: string;
  modsDownloaded: number;
  modsFailed: string[];
  clientModsDisabled: string[];
  launchTarget: string;
  installedAt: string;
}

export function readInstalledModpack(serverDir: string): InstalledModpack | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(serverDir, MODPACK_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/** True when this directory already holds a built copy of the requested pack. */
export function isModpackInstalled(serverDir: string, slug: string): boolean {
  const installed = readInstalledModpack(serverDir);
  return !!installed && installed.slug === slug;
}

export interface ProvisionOptions {
  slug: string;
  /** Panel's configured version. 'LATEST' means "whatever the pack's newest release targets". */
  mcVersion?: string;
  /** Only set when the caller genuinely knows; otherwise the pack's own manifest decides. */
  loader?: string;
  /** Rebuild even if a marker is already present. */
  force?: boolean;
}

/**
 * Downloads and builds the pack into `serverDir`.
 *
 * Progress is pushed through the provisioning log so it shows up in the panel console
 * while the build runs — a large pack takes minutes, and silence there reads as a hang.
 */
export async function provisionModrinthPack(
  serverId: string,
  serverDir: string,
  options: ProvisionOptions
): Promise<InstalledModpack> {
  const { slug, mcVersion, loader, force } = options;

  const existing = readInstalledModpack(serverDir);
  if (existing && existing.slug === slug && !force) {
    provisioningManager.emitLog(serverId, 'daemon', `[Modpack] '${slug}' is already installed — skipping rebuild.`);
    return existing;
  }

  const log = (line: string) => {
    console.log(`[Modpack ${serverId}] ${line}`);
    provisioningManager.emitLog(serverId, 'daemon', `[Modpack] ${line}`);
  };

  fs.mkdirSync(serverDir, { recursive: true });

  log(`Resolving '${slug}' on Modrinth…`);
  const details = await resolveMrpackDetails(slug, { gameVersion: mcVersion, loader });
  log(`Selected ${details.versionNumber} (${details.versionId}).`);

  // Kept out of the server root: the extractor below lays the pack's own overrides over this
  // directory, and a stray archive sitting among them looks like pack content.
  const archivePath = path.join(serverDir, '.modrinth-pack.mrpack');
  log('Downloading pack…');
  await downloadModrinthFile(details.url, archivePath);

  const sizeMb = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
  log(`Downloaded ${sizeMb} MB. Extracting manifest…`);

  try {
    // A .mrpack is a zip. AdmZip is enough here: the archive holds a manifest and overrides,
    // not the thousands of entries a full server pack would.
    new AdmZip(archivePath).extractAllTo(serverDir, true);
  } catch (err: any) {
    throw new Error(`The .mrpack for '${slug}' could not be extracted: ${err.message}`);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  const packRoot = findMrpackRoot(serverDir);
  if (!packRoot) {
    throw new Error(
      `'${slug}' does not contain a modrinth.index.json, so it is not a Modrinth modpack the panel can build.`
    );
  }

  log('Building server from manifest — downloading mods and installing the loader…');
  const built = await materializeMrpack(serverId, serverDir, packRoot);

  if (built.modsFailed.length > 0) {
    log(`${built.modsFailed.length} file(s) could not be downloaded: ${built.modsFailed.slice(0, 5).join(', ')}` +
        (built.modsFailed.length > 5 ? ', …' : ''));
  }
  if (built.clientModsDisabled.length > 0) {
    log(`${built.clientModsDisabled.length} client-only mod(s) moved aside so the server can boot.`);
  }
  log(`Ready: ${built.loader}${built.loaderVersion ? ` ${built.loaderVersion}` : ''} for Minecraft ${built.mcVersion || 'unknown'}, ${built.modsDownloaded} mod(s) installed.`);

  const installed: InstalledModpack = {
    slug,
    versionId: details.versionId,
    versionNumber: details.versionNumber,
    name: built.name,
    mcVersion: built.mcVersion,
    loader: built.loader,
    loaderVersion: built.loaderVersion,
    modsDownloaded: built.modsDownloaded,
    modsFailed: built.modsFailed,
    clientModsDisabled: built.clientModsDisabled,
    launchTarget: built.launchTarget,
    installedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(serverDir, MODPACK_MARKER), JSON.stringify(installed, null, 2));

  // The pack decides the real Minecraft version and loader, and the launcher reads them back
  // from here. Leaving the panel's placeholder ('LATEST', or the wrong loader) in place would
  // have the server started with the wrong Java runtime.
  syncMetaFromPack(serverDir, installed);

  // The container runs as uid 1000; files written by the daemon are root-owned without this.
  try {
    execSync(`chown -R 1000:1000 "${serverDir}"`);
    execSync(`chmod -R 775 "${serverDir}"`);
  } catch {
    // Not fatal, and not applicable when the daemon runs unprivileged or on a non-POSIX host.
  }

  return installed;
}

/** Folds the detected version and loader back into craftcontrol-meta.json. */
function syncMetaFromPack(serverDir: string, installed: InstalledModpack) {
  const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    // A missing meta file is recoverable — write what we know.
  }

  if (installed.mcVersion) {
    meta.mcVersion = installed.mcVersion;
    meta.installedVersion = installed.mcVersion;
  }
  meta.modpackSlug = installed.slug;
  meta.modpackVersion = installed.versionNumber;
  meta.detectedLoader = installed.loader;
  if (installed.loaderVersion) meta.loaderVersion = installed.loaderVersion;

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    // Worst case the server starts on the panel's declared version instead of the pack's.
  }
}
