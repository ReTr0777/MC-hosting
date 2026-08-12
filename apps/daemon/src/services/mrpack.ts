import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import {
  MrpackManifestFile,
  downloadManifestFiles,
  isServerRelevant,
  resolveInsideDir,
  lookupVersionsByHashes,
  getModrinthProjects,
  DENYLIST_PATH_SUBSTRINGS,
} from './modrinth';
import { sanitizeModJarsAndLangFiles } from './serverpackcreator';
import { provisioningManager } from './provisioning';
import { resolveJavaCmd } from './process';

export const MRPACK_INDEX_FILENAME = 'modrinth.index.json';

/** The subset of `modrinth.index.json` we actually act on. */
export interface MrpackIndex {
  formatVersion?: number;
  game?: string;
  versionId?: string;
  name?: string;
  files?: MrpackManifestFile[];
  dependencies?: Record<string, string>;
}

export type MrpackLoader = 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'vanilla';

export interface MrpackBuildResult {
  name?: string;
  mcVersion?: string;
  loader: MrpackLoader;
  loaderVersion?: string;
  modsDownloaded: number;
  modsFailed: string[];
  /** Client-only mods moved out of mods/ so the server can boot. */
  clientModsDisabled: string[];
  /** Root-relative file the server will actually be launched from. */
  launchTarget: string;
}

/**
 * Locates `modrinth.index.json` at the root of an extracted upload, or one level down (some
 * packs are re-zipped inside a wrapper folder). Returns the directory holding it — the pack root.
 */
export function findMrpackRoot(serverDir: string): string | null {
  if (fs.existsSync(path.join(serverDir, MRPACK_INDEX_FILENAME))) return serverDir;

  let entries: string[];
  try {
    entries = fs.readdirSync(serverDir);
  } catch (e) {
    return null;
  }

  for (const entry of entries) {
    const candidate = path.join(serverDir, entry);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch (e) {
      continue;
    }
    if (fs.existsSync(path.join(candidate, MRPACK_INDEX_FILENAME))) return candidate;
  }

  return null;
}

function log(serverId: string, message: string) {
  console.log(message);
  provisioningManager.emitLog(serverId, 'daemon', message);
}

/**
 * Recursively copies `srcDir` over `destDir`, overwriting collisions. Entry names are resolved
 * through resolveInsideDir so a malicious archive can't escape the server directory via symlink
 * or traversal-shaped names.
 */
function copyDirInto(srcDir: string, destDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  let copied = 0;

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = resolveInsideDir(destDir, entry.name);
    if (!to) {
      console.warn(`[mrpack] Skipping override entry with unsafe name: '${entry.name}'`);
      continue;
    }

    if (entry.isSymbolicLink()) {
      console.warn(`[mrpack] Skipping symlink in overrides: '${entry.name}'`);
      continue;
    }

    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copied += copyDirInto(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied++;
    }
  }

  return copied;
}

/** Runs a loader installer jar, streaming its output into the server's provisioning console. */
function runInstaller(serverId: string, javaCmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaCmd, args, { cwd, env: process.env });

    child.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[mrpack installer] ${line}`);
    });
    child.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.warn(`[mrpack installer] ${line}`);
    });

    child.on('error', (err) => reject(new Error(`Failed to launch loader installer: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Loader installer exited with code ${code}`));
    });
  });
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

/**
 * Runs the Forge/NeoForge `--installServer` flow, which materializes the `libraries/` tree plus
 * the run.sh/run.bat launch scripts the rest of the panel already knows how to start.
 */
async function installForgeFamilyServer(
  serverId: string,
  serverDir: string,
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string
): Promise<string> {
  const installerUrl =
    kind === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;

  const workDir = path.join(serverDir, '.mrpack-installer');
  const installerPath = path.join(workDir, `${kind}-installer.jar`);

  log(serverId, `[mrpack] Downloading ${kind} ${loaderVersion} server installer...`);
  await downloadTo(installerUrl, installerPath);

  log(serverId, `[mrpack] Running ${kind} --installServer (this downloads the loader's libraries)...`);
  const javaCmd = resolveJavaCmd(mcVersion);
  await runInstaller(serverId, javaCmd, ['-jar', installerPath, '--installServer', serverDir], serverDir);

  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(path.join(serverDir, `${kind}-installer.jar.log`), { force: true });
    fs.rmSync(path.join(serverDir, 'installer.log'), { force: true });
  } catch (e) {}

  if (fs.existsSync(path.join(serverDir, 'run.sh'))) {
    try {
      fs.chmodSync(path.join(serverDir, 'run.sh'), 0o755);
    } catch (e) {}
    return 'run.sh';
  }

  // Older Forge lines (pre-1.17) install a plain launch jar instead of run.sh.
  const jar = fs
    .readdirSync(serverDir)
    .find((f) => /^(forge|neoforge).*\.jar$/i.test(f) && !/installer/i.test(f));
  if (jar) {
    fs.renameSync(path.join(serverDir, jar), path.join(serverDir, 'server.jar'));
    return 'server.jar';
  }

  throw new Error(`${kind} installer completed but produced neither run.sh nor a launch jar`);
}

/**
 * Installs the Fabric server launcher jar as server.jar — the same endpoint and convention the
 * process manager already uses when provisioning a plain Fabric server.
 */
async function installFabricServer(serverId: string, serverDir: string, mcVersion: string, loaderVersion: string): Promise<string> {
  let installerVersion = '1.0.1';
  try {
    const res = await fetch('https://meta.fabricmc.net/v2/versions/installer');
    if (res.ok) {
      const versions = await res.json();
      if (Array.isArray(versions) && versions[0]?.version) installerVersion = versions[0].version;
    }
  } catch (e) {
    console.warn(`[mrpack] Couldn't resolve latest Fabric installer version, falling back to ${installerVersion}`);
  }

  const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/${installerVersion}/server/jar`;
  log(serverId, `[mrpack] Downloading Fabric server launcher (loader ${loaderVersion}, installer ${installerVersion})...`);
  await downloadTo(url, path.join(serverDir, 'server.jar'));
  return 'server.jar';
}

/**
 * Installs a Quilt server via the official installer, then normalizes the resulting launch jar to
 * server.jar so it flows through the same start path as every other jar-based server.
 */
async function installQuiltServer(serverId: string, serverDir: string, mcVersion: string, loaderVersion: string): Promise<string> {
  let installerVersion: string | null = null;
  try {
    const res = await fetch('https://meta.quiltmc.org/v3/versions/installer');
    if (res.ok) {
      const versions = await res.json();
      if (Array.isArray(versions) && versions[0]?.version) installerVersion = versions[0].version;
    }
  } catch (e) {}
  if (!installerVersion) throw new Error('Could not resolve a Quilt installer version');

  const workDir = path.join(serverDir, '.mrpack-installer');
  const installerPath = path.join(workDir, 'quilt-installer.jar');
  const url = `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVersion}/quilt-installer-${installerVersion}.jar`;

  log(serverId, `[mrpack] Downloading Quilt installer ${installerVersion}...`);
  await downloadTo(url, installerPath);

  log(serverId, `[mrpack] Running Quilt server install (loader ${loaderVersion})...`);
  await runInstaller(
    serverId,
    resolveJavaCmd(mcVersion),
    ['-jar', installerPath, 'install', 'server', mcVersion, loaderVersion, '--download-server', `--install-dir=${serverDir}`],
    serverDir
  );

  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {}

  const launchJar = path.join(serverDir, 'quilt-server-launch.jar');
  if (fs.existsSync(launchJar)) {
    fs.renameSync(launchJar, path.join(serverDir, 'server.jar'));
    return 'server.jar';
  }

  throw new Error('Quilt installer completed but produced no quilt-server-launch.jar');
}

/** Downloads the vanilla server jar for packs that declare no mod loader at all. */
async function installVanillaServer(serverId: string, serverDir: string, mcVersion: string): Promise<string> {
  const manifestRes = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  if (!manifestRes.ok) throw new Error(`Mojang version manifest unavailable (HTTP ${manifestRes.status})`);
  const manifest = await manifestRes.json();
  const entry = (manifest.versions || []).find((v: any) => v.id === mcVersion);
  if (!entry) throw new Error(`Minecraft version '${mcVersion}' not found in Mojang's manifest`);

  const detailRes = await fetch(entry.url);
  if (!detailRes.ok) throw new Error(`Failed to fetch version metadata for ${mcVersion}`);
  const detail = await detailRes.json();
  const serverUrl = detail?.downloads?.server?.url;
  if (!serverUrl) throw new Error(`Minecraft ${mcVersion} publishes no server download`);

  log(serverId, `[mrpack] Downloading vanilla Minecraft ${mcVersion} server jar...`);
  await downloadTo(serverUrl, path.join(serverDir, 'server.jar'));
  return 'server.jar';
}

/** Directory client-only mods are moved into, rather than deleted, so they can be restored. */
export const CLIENT_MODS_DIR = 'client-mods-disabled';

/**
 * Mods that are client-only but frequently ship without usable metadata (or aren't on Modrinth at
 * all). Matched against the jar filename as a last resort, after the metadata and API checks.
 */
const CLIENT_ONLY_NAME_HINTS = [
  'optifine', 'iris', 'sodium', 'embeddium', 'rubidium', 'oculus', 'canvas',
  'modmenu', 'reeses-sodium', 'indium', 'entityculling', 'betterf3', 'zoomify',
  'controlling', 'xaeros', 'dynamic-fps', 'immediatelyfast',
  'entity-texture-features', 'entity-model-features', 'fabricskyboxes', 'continuity',
  'lambdynamiclights', 'notenoughanimations', 'firstperson', 'shoulder-surfing',
  'ok-zoomer', 'drippyloadingscreen',
];

/**
 * Reads a mod jar's own loader metadata to see if it declares itself client-only. Fabric and
 * Quilt both publish an explicit environment field, which is authoritative and needs no network.
 * Forge's mods.toml has no equivalent, so those fall through to the Modrinth lookup.
 */
function jarDeclaresClientOnly(jarPath: string): boolean | null {
  try {
    const zip = new AdmZip(jarPath);

    const fabricEntry = zip.getEntry('fabric.mod.json');
    if (fabricEntry) {
      // fabric.mod.json is allowed to contain comments, which JSON.parse rejects.
      const raw = zip.readAsText(fabricEntry).replace(/^\s*\/\/.*$/gm, '');
      const meta = JSON.parse(raw);
      if (typeof meta.environment === 'string') {
        const env = meta.environment.toLowerCase();
        if (env === 'client') return true;
        if (env === 'server' || env === '*') return false;
      }
    }

    const quiltEntry = zip.getEntry('quilt.mod.json');
    if (quiltEntry) {
      const meta = JSON.parse(zip.readAsText(quiltEntry));
      const env = meta?.minecraft?.environment;
      if (typeof env === 'string') {
        const lower = env.toLowerCase();
        if (lower === 'client') return true;
        if (lower === 'dedicated_server' || lower === '*') return false;
      }
    }
  } catch (e) {
    // Unreadable or non-standard jar — fall through to the other checks.
  }
  return null;
}

function sha1OfFile(filePath: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').toLowerCase();
}

export interface ClientModScanResult {
  moved: string[];
  scanned: number;
}

/**
 * Finds mods that cannot run on a dedicated server and moves them out of mods/ into
 * client-mods-disabled/.
 *
 * Client-focused modpacks bundle these jars straight into overrides/mods/, where they carry no
 * manifest env metadata — so without this pass a client pack installs a mods folder full of
 * rendering mods and the server dies on first boot. Detection runs strongest-signal-first: the
 * jar's own declared environment, then Modrinth's project record looked up by file hash, then a
 * filename match for the well-known offenders that have neither.
 */
export async function quarantineClientOnlyMods(serverId: string, serverDir: string): Promise<ClientModScanResult> {
  const modsDir = path.join(serverDir, 'mods');
  if (!fs.existsSync(modsDir)) return { moved: [], scanned: 0 };

  const jars = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
  if (jars.length === 0) return { moved: [], scanned: 0 };

  const clientOnly = new Set<string>();
  // Jars something authoritative has confirmed run server-side. The filename pass must not
  // second-guess these — a hint like 'sodium' would otherwise strip a legitimately server-safe
  // mod whose name merely contains it.
  const confirmedServerSafe = new Set<string>();
  const undecided: string[] = [];

  // Pass 1 — the jar's own metadata.
  for (const jar of jars) {
    const verdict = jarDeclaresClientOnly(path.join(modsDir, jar));
    if (verdict === true) clientOnly.add(jar);
    else if (verdict === false) confirmedServerSafe.add(jar);
    else undecided.push(jar);
  }

  // Pass 2 — ask Modrinth what the remaining jars actually are, by hash.
  if (undecided.length > 0) {
    try {
      const hashToJar = new Map<string, string>();
      for (const jar of undecided) {
        try {
          hashToJar.set(sha1OfFile(path.join(modsDir, jar)), jar);
        } catch (e) {}
      }

      const versions = await lookupVersionsByHashes(Array.from(hashToJar.keys()));
      const projectIds = Array.from(new Set(Array.from(versions.values()).map((v: any) => v.project_id).filter(Boolean)));

      if (projectIds.length > 0) {
        const projects = await getModrinthProjects(projectIds);
        for (const [hash, version] of versions.entries()) {
          const project = projects.get((version as any).project_id);
          const jar = hashToJar.get(hash);
          if (!jar || !project) continue;
          if (project.server_side === 'unsupported') clientOnly.add(jar);
          else confirmedServerSafe.add(jar);
        }
      }
    } catch (err: any) {
      console.warn(`[mrpack] Modrinth client-mod lookup failed (${err.message}) — falling back to name matching only`);
    }
  }

  // Pass 3 — filename hints, only for jars neither of the reliable checks could classify.
  for (const jar of jars) {
    if (clientOnly.has(jar) || confirmedServerSafe.has(jar)) continue;
    const lower = jar.toLowerCase();
    if (CLIENT_ONLY_NAME_HINTS.some((hint) => lower.includes(hint))) clientOnly.add(jar);
  }

  if (clientOnly.size === 0) {
    log(serverId, `[mrpack] Scanned ${jars.length} mod(s) — all are server-compatible`);
    return { moved: [], scanned: jars.length };
  }

  const quarantineDir = path.join(serverDir, CLIENT_MODS_DIR);
  fs.mkdirSync(quarantineDir, { recursive: true });

  const moved: string[] = [];
  for (const jar of clientOnly) {
    try {
      fs.renameSync(path.join(modsDir, jar), path.join(quarantineDir, jar));
      moved.push(jar);
    } catch (e: any) {
      console.warn(`[mrpack] Couldn't quarantine '${jar}': ${e.message}`);
    }
  }

  log(
    serverId,
    `[mrpack] Moved ${moved.length} client-only mod(s) out of mods/ into ${CLIENT_MODS_DIR}/ so the server can boot: ${moved.slice(0, 8).join(', ')}${moved.length > 8 ? `, +${moved.length - 8} more` : ''}`
  );

  return { moved, scanned: jars.length };
}

/** Maps the pack's `dependencies` block onto a loader and its version. */
function resolveLoader(dependencies: Record<string, string>): { loader: MrpackLoader; version?: string } {
  if (dependencies['forge']) return { loader: 'forge', version: dependencies['forge'] };
  if (dependencies['neoforge']) return { loader: 'neoforge', version: dependencies['neoforge'] };
  if (dependencies['fabric-loader']) return { loader: 'fabric', version: dependencies['fabric-loader'] };
  if (dependencies['quilt-loader']) return { loader: 'quilt', version: dependencies['quilt-loader'] };
  return { loader: 'vanilla' };
}

/**
 * Turns an extracted Modrinth `.mrpack` into a launchable server directory:
 * resolves the manifest, downloads every server-relevant mod with hash verification, lays the
 * pack's overrides down in the correct precedence order, and installs the declared mod loader so
 * a run.sh / server.jar exists for the normal start path to pick up.
 */
export async function materializeMrpack(serverId: string, serverDir: string, packRoot: string): Promise<MrpackBuildResult> {
  const indexPath = path.join(packRoot, MRPACK_INDEX_FILENAME);
  const index: MrpackIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  if (index.game && index.game !== 'minecraft') {
    throw new Error(`Unsupported .mrpack game '${index.game}' — only 'minecraft' packs can be deployed`);
  }

  const dependencies = index.dependencies || {};
  const mcVersion = dependencies['minecraft'];
  const { loader, version: loaderVersion } = resolveLoader(dependencies);

  if (!mcVersion) {
    throw new Error(`.mrpack manifest declares no 'minecraft' dependency, so the server version is unknown`);
  }

  log(
    serverId,
    `[mrpack] Building '${index.name || 'Modrinth pack'}' — Minecraft ${mcVersion}, ${loader}${loaderVersion ? ` ${loaderVersion}` : ''}`
  );

  // 1. Overrides, in Modrinth's defined precedence: shared overrides first, then server-specific
  //    ones on top. client-overrides are deliberately dropped — they're client-only assets.
  for (const dirName of ['overrides', 'server-overrides']) {
    const src = path.join(packRoot, dirName);
    if (!fs.existsSync(src)) continue;
    const count = copyDirInto(src, serverDir);
    log(serverId, `[mrpack] Applied ${count} file(s) from ${dirName}/`);
    fs.rmSync(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  fs.rmSync(path.join(packRoot, 'client-overrides'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  // Keep the manifest at the server root so the panel's existing version auto-detection can read
  // it, then collapse the wrapper folder if the pack was nested inside one.
  if (path.resolve(packRoot) !== path.resolve(serverDir)) {
    copyDirInto(packRoot, serverDir);
    fs.rmSync(packRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // 2. Manifest downloads. Client-only entries are skipped, as are the mods the panel already
  //    knows break dedicated servers.
  const allFiles = Array.isArray(index.files) ? index.files : [];
  const wanted = allFiles.filter((f) => {
    if (!isServerRelevant(f)) return false;
    const lower = (f.path || '').toLowerCase();
    if (DENYLIST_PATH_SUBSTRINGS.some((s) => lower.includes(s))) {
      console.log(`[mrpack] Skipping denylisted client mod: ${f.path}`);
      return false;
    }
    return true;
  });

  log(serverId, `[mrpack] Downloading ${wanted.length} server-side file(s) from the manifest (${allFiles.length - wanted.length} client-only entries skipped)...`);
  const dl = await downloadManifestFiles(wanted, serverDir, {
    onProgress: (done, total) => log(serverId, `[mrpack] Downloaded ${done}/${total} files`),
  });

  if (dl.failed.length > 0) {
    log(serverId, `[mrpack] WARNING: ${dl.failed.length} file(s) could not be downloaded: ${dl.failed.slice(0, 5).join(', ')}${dl.failed.length > 5 ? ', ...' : ''}`);
  }

  // 3. Strip mods that can't run on a dedicated server. This is what makes client-side modpacks
  //    (where most of mods/ is rendering/UI mods bundled into overrides) deployable at all.
  const clientScan = await quarantineClientOnlyMods(serverId, serverDir);

  // 4. Install the loader so the directory becomes launchable.
  let launchTarget: string;
  if (loader === 'forge' || loader === 'neoforge') {
    launchTarget = await installForgeFamilyServer(serverId, serverDir, loader, mcVersion, loaderVersion!);
  } else if (loader === 'fabric') {
    launchTarget = await installFabricServer(serverId, serverDir, mcVersion, loaderVersion!);
  } else if (loader === 'quilt') {
    launchTarget = await installQuiltServer(serverId, serverDir, mcVersion, loaderVersion!);
  } else {
    launchTarget = await installVanillaServer(serverId, serverDir, mcVersion);
  }

  // 5. Housekeeping the rest of the pipeline expects.
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
  sanitizeModJarsAndLangFiles(path.join(serverDir, 'mods'));

  log(
    serverId,
    `[mrpack] Build complete — ${dl.downloaded} file(s) installed, ${clientScan.moved.length} client-only mod(s) disabled, launching via ${launchTarget}`
  );

  return {
    name: index.name,
    mcVersion,
    loader,
    loaderVersion,
    modsDownloaded: dl.downloaded,
    modsFailed: dl.failed,
    clientModsDisabled: clientScan.moved,
    launchTarget,
  };
}
