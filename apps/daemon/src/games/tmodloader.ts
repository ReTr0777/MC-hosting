import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { DEFAULT_TMODLOADER_VERSION } from '@mc-manager/shared';
import { getConfig } from '../config';
import { LaunchSpec } from './types';

/**
 * tModLoader: installation, launch, and where its mods live.
 *
 * Kept apart from terraria.ts because almost nothing is shared. Vanilla Terraria is a
 * Mono binary downloaded from terraria.org and spawned directly; tModLoader is a .NET
 * application distributed on GitHub that brings its own runtime bootstrapper. They
 * overlap only in `serverconfig.txt` and the shape of a world file.
 */

/**
 * The tModLoader build we install.
 *
 * Unlike terraria.org, GitHub does publish a "latest" release — but resolving it at
 * install time would mean two nodes installing different builds on different days, and a
 * mod compiled against one tModLoader version refuses to load on another. Pinning is what
 * makes "the same server, moved to another node" mean the same thing.
 *
 * tModLoader versions are date-based: v2026.06.3.6 is the 2026.06 series. Bumping this is
 * a one-line change, but it invalidates every installed `.tmod` built for the old series,
 * so treat it as a migration rather than an upgrade.
 *
 * Defined in shared alongside the Terraria version each build targets, because worldgen
 * needs that pairing and the panel needs the list.
 */
export const TMODLOADER_VERSION = DEFAULT_TMODLOADER_VERSION;

/** `2026.06.3.6` → the GitHub release asset for that tag. */
export function tmodloaderDownloadUrl(version: string): string {
  return `https://github.com/tModLoader/tModLoader/releases/download/v${version}/tModLoader.zip`;
}

function tmodloaderCacheRoot(): string {
  return path.join(getConfig().dataDir, 'cache', 'tmodloader');
}

/** Where a fully unpacked build lives once installed. Mirrors the vanilla cache. */
export function tmodloaderVersionDir(version: string): string {
  return path.join(tmodloaderCacheRoot(), version);
}

/**
 * The script we spawn.
 *
 * Not `start-tModLoaderServer.sh`, which calls this one as a child and would leave
 * ProcessManager holding the pid of a shell rather than of the server — the same trap
 * documented in terraria.ts for the vanilla wrapper, where the Resources tab reported a
 * few megabytes for a server using hundreds.
 *
 * ScriptCaller.sh is safe to spawn because it finishes with `exec dotnet tModLoader.dll`,
 * replacing itself with the real process, so the pid we are handed becomes the pid we
 * want. It also locates or installs the .NET runtime, which is why we go through it at
 * all instead of invoking dotnet ourselves.
 */
export function tmodloaderLauncherPath(version: string): string {
  return path.join(tmodloaderVersionDir(version), 'LaunchUtils', 'ScriptCaller.sh');
}

/** In-flight installs, keyed by version, so two servers cannot both download 60 MB. */
const installs = new Map<string, Promise<string>>();

export function ensureTmodloaderBinary(version: string): Promise<string> {
  const existing = installs.get(version);
  if (existing) return existing;

  const job = install(version).finally(() => installs.delete(version));
  installs.set(version, job);
  return job;
}

async function install(version: string): Promise<string> {
  const launcher = tmodloaderLauncherPath(version);
  if (fs.existsSync(launcher)) return launcher;

  const root = tmodloaderCacheRoot();
  fs.mkdirSync(root, { recursive: true });

  const url = tmodloaderDownloadUrl(version);
  console.log(`[tModLoader] Cache miss for ${version}; downloading ${url}`);

  // GitHub serves release assets from a redirect to objects.githubusercontent.com.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Could not download tModLoader ${version} (HTTP ${res.status}). ` +
      'The version must match a published release tag exactly — tModLoader uses date-based ' +
      'versions such as 2026.06.3.6, not Terraria version numbers.'
    );
  }

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  // Unpacked beside the target and renamed into place, so a crash mid-extract cannot leave
  // a half-installed build that the existsSync check above would accept.
  const staging = fs.mkdtempSync(path.join(root, `.staging-${version}-`));
  try {
    zip.extractAllTo(staging, true);

    // The archive unpacks flat, but locate the marker rather than assuming: a layout change
    // should surface as a clear error, not as a path that silently does not exist.
    const buildRoot = findBuildRoot(staging);
    if (!buildRoot) {
      throw new Error(
        `tModLoader ${version} archive has no LaunchUtils/ScriptCaller.sh — the download layout has changed.`
      );
    }

    /*
     * AdmZip does not preserve the executable bit, and every one of these is invoked as a
     * program by the launch chain. Missing it fails with "Permission denied" from a script
     * the operator never asked to run, which is a hard error to place.
     */
    makeScriptsExecutable(buildRoot);

    try {
      fs.renameSync(buildRoot, tmodloaderVersionDir(version));
    } catch (err: any) {
      // Another daemon process on the same data dir won the race; its build is as good as
      // ours, so use it rather than failing the start.
      if (!fs.existsSync(launcher)) throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[tModLoader] Installed ${version} to ${tmodloaderVersionDir(version)}`);
  return launcher;
}

/** The directory containing LaunchUtils/ScriptCaller.sh, at whatever depth it unpacked to. */
function findBuildRoot(root: string): string | null {
  if (fs.existsSync(path.join(root, 'LaunchUtils', 'ScriptCaller.sh'))) return root;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findBuildRoot(path.join(root, entry.name));
    if (nested) return nested;
  }
  return null;
}

function makeScriptsExecutable(buildRoot: string): void {
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.sh') || entry.name === 'dotnet') {
        try {
          fs.chmodSync(full, 0o755);
        } catch {
          // A file we cannot chmod is not necessarily one that needs it.
        }
      }
    }
  };
  walk(buildRoot);
}

/* ------------------------------------------------------------------------- */
/* Mods                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Where this server's `.tmod` files live.
 *
 * Inside the server directory rather than tModLoader's default
 * `~/.local/share/Terraria/tModLoader/Mods`, which is shared by every server on the node —
 * two servers would silently load each other's mods, and a backup of one server would not
 * contain the mods it needs to start. `-modpath` below points tModLoader here.
 */
export function modsDir(serverDir: string): string {
  return path.join(serverDir, 'Mods');
}

/**
 * The file that decides which mods actually load.
 *
 * Required even for mods installed by hand: tModLoader loads what `enabled.json` lists and
 * ignores everything else in the folder. A `.tmod` present but unlisted is the most
 * confusing possible state — the file is plainly there, and the mod is simply not on.
 */
export function enabledJsonPath(serverDir: string): string {
  return path.join(modsDir(serverDir), 'enabled.json');
}

/** Mod internal names currently enabled. Missing or corrupt file reads as "none". */
export function readEnabledMods(serverDir: string): string[] {
  try {
    const raw = fs.readFileSync(enabledJsonPath(serverDir), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function writeEnabledMods(serverDir: string, names: string[]): void {
  fs.mkdirSync(modsDir(serverDir), { recursive: true });
  // Sorted and de-duplicated so the file does not churn between writes, and indented
  // because an operator editing it by hand is a supported way to work.
  const unique = Array.from(new Set(names)).sort();
  fs.writeFileSync(enabledJsonPath(serverDir), JSON.stringify(unique, null, 2));
}

/**
 * A mod's internal name, read from the `.tmod` file header.
 *
 * The internal name is what `enabled.json` must contain, and it is **not** reliably the
 * filename: mods are commonly distributed as `Some Mod v1.2.tmod` while calling themselves
 * `SomeMod` internally. Enabling by filename produces a mod that is present, listed, and
 * still does not load.
 *
 * The header is: magic "TMOD", then the tModLoader version string, then a 20-byte hash, a
 * 256-byte signature, a 4-byte data length, and then the mod's own name and version — all
 * as .NET BinaryWriter length-prefixed strings (a 7-bit encoded length, then UTF-8 bytes).
 *
 * Returns null rather than throwing on anything unexpected: an unreadable header means we
 * fall back to the filename, which is worth trying, whereas a thrown error would make one
 * malformed upload break the whole mod list.
 */
export interface TmodHeader {
  /** Internal name: what enabled.json must contain. */
  name: string;
  /**
   * The tModLoader this mod was compiled against.
   *
   * Read and kept rather than skipped past, because it is the difference between a mod
   * that will load and one that will take the server down. tModLoader reports the mismatch
   * itself — but only after loading has already failed and the disable-and-unload cascade
   * has begun, by which point the crash names whichever mod happened to be unloading.
   */
  builtFor: string;
}

export function readModHeader(tmodPath: string): TmodHeader | null {
  try {
    const buf = fs.readFileSync(tmodPath);
    if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'TMOD') return null;

    const version = readDotNetString(buf, 4);
    if (!version) return null;

    // hash (20) + signature (256) + data length (4)
    const name = readDotNetString(buf, version.next + 20 + 256 + 4);
    if (!name || name.value.length === 0) return null;

    return { name: name.value, builtFor: version.value };
  } catch {
    return null;
  }
}

/** Just the internal name. Kept because most callers want only that. */
export function readModInternalName(tmodPath: string): string | null {
  return readModHeader(tmodPath)?.name ?? null;
}

/** A .NET BinaryWriter string: 7-bit encoded length prefix, then UTF-8 bytes. */
function readDotNetString(buf: Buffer, offset: number): { value: string; next: number } | null {
  let length = 0;
  let shift = 0;
  let cursor = offset;

  while (true) {
    if (cursor >= buf.length || shift > 28) return null;
    const byte = buf[cursor++];
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  if (length < 0 || cursor + length > buf.length) return null;
  return { value: buf.toString('utf8', cursor, cursor + length), next: cursor + length };
}

/* ------------------------------------------------------------------------- */
/* Launch                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * How a tModLoader server is started.
 *
 * `-tmlsavedirectory` and `-modpath` both point inside the server directory. Without them
 * tModLoader writes worlds and reads mods from a per-user path shared by every server on
 * the node, which would make two servers overwrite each other's saves and make a restored
 * backup start with the wrong world.
 */
export function buildTmodloaderLaunch(
  serverDir: string,
  launcherPath: string,
  configPath: string,
  worldFile: string | null
): LaunchSpec {
  return {
    command: launcherPath,
    args: [
      '-server',
      '-config', configPath,
      /*
       * The world is named on the command line, not left to `world=` in serverconfig.txt.
       *
       * Vanilla honours that key, and tModLoader reads the same file — but with
       * -tmlsavedirectory in play it resolves worlds against its own save directory and
       * ignored the configured path, listing the world in its menu and then waiting at
       * `Choose World:` for a keypress no daemon is going to send. That prompt emits no
       * newline, so the server looks hung rather than blocked, which is the exact failure
       * plan.md §6 records for vanilla launched without a complete config.
       *
       * -world removes the decision entirely. Omitted when no world exists yet, because
       * pointing it at a missing file is how you get the same prompt back.
       */
      ...(worldFile ? ['-world', worldFile] : []),
      '-tmlsavedirectory', serverDir,
      '-modpath', modsDir(serverDir),
    ],
    env: {
      /*
       * The launch chain installs .NET beside the build on first run. Pointing HOME at the
       * build directory keeps that download inside the daemon's data directory rather than
       * in the home of whichever user the daemon happens to run as — which on Unraid is
       * root, and would put a runtime in a path no backup covers and no uninstall removes.
       */
      HOME: path.dirname(path.dirname(launcherPath)),
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
    },
  };
}
