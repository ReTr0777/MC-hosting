import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import {
  Game, GAME_CAPABILITIES, parseTerrariaConfig,
  TERRARIA_SECRET_SEEDS, TERRARIA_WORLD_EVILS,
} from '@mc-manager/shared';
import { getConfig } from '../config';
import { GameDefinition, GameServerSpec, LaunchSpec, PresenceEvent } from './types';

/**
 * The Terraria build we install.
 *
 * terraria.org has **no "latest" endpoint** — probing the download API is the
 * only way to discover what exists — so "latest" has to mean "the newest build
 * we chose, tested and wrote down". 1.4.5.6 is the ceiling as of 2026-08-14 and
 * is the version the spike in plan.md §6 was re-run against.
 *
 * Bumping this is a one-line change, but re-run that spike first: the step from
 * 1.4.4.9 to 1.4.5.6 already shifted two of the four findings it records.
 */
export const TERRARIA_VERSION = '1.4.5.6';

/** `1.4.5.6` → `.../terraria-server-1456.zip`. The dots are simply stripped. */
export function terrariaDownloadUrl(version: string): string {
  return `https://terraria.org/api/download/pc-dedicated-server/terraria-server-${version.replace(/\./g, '')}.zip`;
}

function terrariaCacheRoot(): string {
  return path.join(getConfig().dataDir, 'cache', 'terraria');
}

/** Where a fully unpacked build lives once installed. Mirrors `cache/jars` for Minecraft. */
function versionDir(version: string): string {
  return path.join(terrariaCacheRoot(), version);
}

/**
 * The executable we actually spawn.
 *
 * Deliberately the Mono binary rather than the `TerrariaServer` shell wrapper
 * beside it. The wrapper only exports `MONO_IOMAP=all`, picks the architecture
 * and `exec`s — but it does so as a **child**, so spawning the wrapper leaves
 * `ProcessManager` holding the pid of a 3 MB bash process while the real server
 * sits in a different pid. `getProcessStats` reads `ps -o %cpu,rss` against the
 * pid it was given, so the Resources tab would report 3 MB for a server using
 * 600 MB. Spawning the binary directly makes the tracked pid the real one.
 */
function launcherPath(version: string): string {
  return path.join(versionDir(version), 'Linux', 'TerrariaServer.bin.x86_64');
}

/**
 * In-flight installs, keyed by version.
 *
 * Two servers created at the same moment would otherwise both download 45 MB
 * and race to unpack into the same directory.
 */
const installs = new Map<string, Promise<string>>();

/**
 * Download, unpack and cache a Terraria dedicated server build; resolves to the
 * launcher path.
 *
 * The version is a **parameter, never read from `TERRARIA_VERSION` here**, and
 * builds are cached per version. That is what makes a version picker later a
 * `gameConfig` field and a dropdown rather than an installer change — and it
 * lets two pinned versions coexist on one node.
 */
export function ensureTerrariaBinary(version: string): Promise<string> {
  const existing = installs.get(version);
  if (existing) return existing;

  const job = install(version).finally(() => installs.delete(version));
  installs.set(version, job);
  return job;
}

async function install(version: string): Promise<string> {
  const launcher = launcherPath(version);
  if (fs.existsSync(launcher)) {
    return launcher;
  }

  const root = terrariaCacheRoot();
  fs.mkdirSync(root, { recursive: true });

  const url = terrariaDownloadUrl(version);
  console.log(`[Terraria] Cache miss for ${version}; downloading ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    // A wrong version is by far the likeliest cause, and terraria.org answers it
    // with a plain 404 — say so rather than reporting a bare status code.
    throw new Error(
      `Could not download Terraria ${version} (HTTP ${res.status}). ` +
      `terraria.org publishes no "latest" endpoint, so the version must be one that actually exists.`
    );
  }

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  // Unpack beside the target and rename into place, so a crash mid-extract can
  // never leave a half-installed build that the existsSync check above accepts.
  const staging = fs.mkdtempSync(path.join(root, `.staging-${version}-`));
  try {
    zip.extractAllTo(staging, true);

    // The archive unpacks to `<version-with-dots-stripped>/{Linux,Mac,Windows}/`.
    // Find the Linux directory rather than reconstructing that name, so a future
    // layout change surfaces as a clear error instead of a wrong path.
    const linuxDir = findLinuxDir(staging);
    if (!linuxDir) {
      throw new Error(`Terraria ${version} archive has no Linux/ directory — the download layout has changed.`);
    }

    const unpacked = path.join(staging, 'unpacked');
    fs.mkdirSync(unpacked, { recursive: true });
    fs.renameSync(linuxDir, path.join(unpacked, 'Linux'));

    // AdmZip does not preserve the executable bit; both of these need it.
    for (const bin of ['TerrariaServer', 'TerrariaServer.bin.x86_64']) {
      const p = path.join(unpacked, 'Linux', bin);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }

    try {
      fs.renameSync(unpacked, versionDir(version));
    } catch (err: any) {
      // Another daemon process on the same data dir won the race. Its build is
      // as good as ours, so use it rather than failing the start.
      if (!fs.existsSync(launcher)) throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[Terraria] Installed ${version} to ${versionDir(version)}`);
  return launcher;
}

function findLinuxDir(root: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (entry.name === 'Linux') return dir;
    const nested = findLinuxDir(dir);
    if (nested) return nested;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* serverconfig.txt                                                           */
/* ------------------------------------------------------------------------- */

/** Where worlds live for a server. Kept in its own subdirectory so a backup is obvious. */
export function worldDir(serverDir: string): string {
  return path.join(serverDir, 'worlds');
}

export function serverConfigPath(serverDir: string): string {
  return path.join(serverDir, 'serverconfig.txt');
}

/** The world file this server uses, or null when none has been generated yet. */
export function existingWorldFile(serverDir: string): string | null {
  const dir = worldDir(serverDir);
  if (!fs.existsSync(dir)) return null;
  // Terraria decides the filename from the entered world name, so we read what
  // it actually produced rather than trying to predict the slug rule.
  const worlds = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wld'));
  if (worlds.length === 0) return null;
  worlds.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, worlds[0]);
}

function parseConfigFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Keys the panel owns outright and re-asserts on every start.
 *
 * The rest of the file is the operator's to edit. This mirrors what the
 * Minecraft path already does with `server-port` in `server.properties`: the
 * things that must agree with the panel's own records are never left to drift.
 *
 * `language` is on this list for a reason that is not obvious — presence
 * parsing matches Terraria's *localized* join/leave strings, so a changed
 * language silently empties the player list. See plan.md §6 Finding 2.
 */
const PANEL_OWNED_KEYS = ['world', 'worldpath', 'port', 'language', 'upnp'];

/**
 * Writes a complete `serverconfig.txt` before the first launch.
 *
 * This is load-bearing, not a convenience. Launched without a complete config a
 * Terraria server sits at `Choose World: ` **forever** — no error, no exit, and
 * no trailing newline, so a line-based readiness probe sees nothing at all.
 * See plan.md §6 Finding 3.
 *
 * Every path written here is absolute on purpose: MonoKickstart `cd`s to its
 * own directory on startup, so the process's working directory is the shared
 * binary cache, not the server directory. A relative path would resolve into
 * the cache.
 */
export async function prepareTerrariaServerDir(serverDir: string, spec: GameServerSpec): Promise<void> {
  const cfg = parseTerrariaConfig(spec.gameConfig);
  const worlds = worldDir(serverDir);
  fs.mkdirSync(worlds, { recursive: true });

  const file = serverConfigPath(serverDir);
  const existing = parseConfigFile(file);
  const isFirstWrite = existing.size === 0;

  const values = new Map(existing);

  // Seeded once, then left alone — these are the operator's to change afterwards,
  // either through the Settings tab or by editing the file directly.
  if (isFirstWrite) {
    values.set('worldname', cfg.worldName);
    values.set('maxplayers', String(cfg.maxPlayers));
    values.set('secure', cfg.secure === false ? '0' : '1');
    if (cfg.password) values.set('password', cfg.password);
    if (cfg.motd) values.set('motd', cfg.motd);

    // Recorded for the panel to display, never read back by Terraria: the world
    // was generated interactively by `generateTerrariaWorld`, and these values
    // are baked into the .wld from that moment on.
    values.set('difficulty', String(cfg.difficulty));
    values.set('autocreate', String(cfg.autocreate));
    values.set('evil', cfg.evil ?? 'RANDOM');
    if (cfg.seed) values.set('seed', cfg.seed);
    for (const flag of cfg.secretSeeds ?? []) {
      values.set(`seed_${flag}`, '1');
    }
  }

  // Re-asserted every start. `world` points at whatever the generation pass
  // actually produced, so the server loads it rather than prompting.
  const world = existingWorldFile(serverDir);
  if (world) values.set('world', world);
  values.set('worldpath', worlds);
  values.set('port', String(spec.serverPort));
  // `en-US`, the form the shipped serverconfig.txt template documents. Pinned and
  // not user-editable because presence parsing matches Terraria's *localized*
  // join/leave strings — see plan.md §6 Finding 2.
  values.set('language', 'en-US');
  values.set('upnp', '0');

  const lines = [
    '# Managed by CraftControl.',
    `# ${PANEL_OWNED_KEYS.join(', ')} are rewritten on every start — edit them in the panel.`,
    '# Everything else is yours; it is preserved across restarts.',
    '',
    ...[...values.entries()].map(([k, v]) => `${k}=${v}`),
    '',
  ];

  // Always LF: this file is read by the Linux build, never by a Windows one.
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------------------- */
/* World generation                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Generates the world by driving Terraria's interactive prompts.
 *
 * This exists because **the world evil cannot be set any other way**. The
 * dedicated server has no `evil` config key and no command-line flag for it —
 * verified against the binary's own config-key and CLI-flag tables — so
 * `autocreate` can only ever produce a random evil. The same interactive menu
 * is also the only route to the Skyblock world type.
 *
 * It runs as a short-lived process of its own and is thrown away once the world
 * file exists; the real server is then started normally with `world=` pointing
 * at the result, which is the plain, already-proven load path. Two passes rather
 * than one because after generating a world the server returns to its
 * world-selection menu instead of starting, and navigating back out of that menu
 * is far more fragile than simply starting again.
 *
 * The prompt sequence, all of which end in `:` — but only some with a trailing
 * space, which is why the matchers tolerate both:
 *
 *   Choose World -> Choose size -> Choose difficulty -> Choose world evil
 *   -> Enter world name -> Enter Seed -> secret-seed toggle menu (repeats)
 */
export function generateTerrariaWorld(
  serverDir: string,
  binaryPath: string,
  spec: GameServerSpec,
  log: (line: string) => void
): Promise<void> {
  const cfg = parseTerrariaConfig(spec.gameConfig);
  const worlds = worldDir(serverDir);
  fs.mkdirSync(worlds, { recursive: true });

  // A config with a worldpath but no `world=` and no `autocreate` is what puts
  // the server into the interactive flow in the first place.
  const configPath = path.join(serverDir, 'worldgen.txt');
  fs.writeFileSync(configPath, [
    `worldpath=${worlds}`,
    `port=${spec.serverPort}`,
    'language=en-US',
    'upnp=0',
    '',
  ].join('\n'), 'utf8');

  const evilIndex = TERRARIA_WORLD_EVILS.find((e) => e.id === (cfg.evil ?? 'RANDOM'))?.menuIndex ?? 1;
  const toggles = TERRARIA_SECRET_SEEDS
    .filter((s) => (cfg.secretSeeds ?? []).includes(s.id))
    .map((s) => s.menuIndex);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, ['-config', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MONO_IOMAP: 'all' },
    });

    let pending = '';
    let generated = false;
    let settled = false;
    let toggleIndex = 0;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      try { fs.rmSync(configPath, { force: true }); } catch (e) { /* best effort */ }
      err ? reject(err) : resolve();
    };

    const answer = (value: string) => {
      pending = '';
      if (child.killed || !child.stdin || !child.stdin.writable) return;
      try { child.stdin.write(`${value}\n`); } catch (e) { /* raced with exit */ }
    };

    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8');
      pending += text;

      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^(:\s*)+/, '').trim();
        if (!line) continue;
        if (/^Creating world/.test(line)) {
          generated = true;
          log(line);
        } else if (!isTerrariaNoiseLine(line)) {
          log(line);
        }
      }

      if (!/:\s*$/.test(pending)) return;

      // Once the world is written the menu comes back; that is the finish line.
      if (generated && /Choose World:\s*$/i.test(pending)) return finish();

      // Order matters. "Choose world evil:" contains "Choose world", and the
      // toggle menu's prompt contains "Enter Seed" — the more specific patterns
      // have to be tested first or the answers go to the wrong prompt.
      if (/Enter Seed Number[^:]*:\s*$/i.test(pending)) {
        return answer(toggleIndex < toggles.length ? String(toggles[toggleIndex++]) : '');
      }
      if (/Choose world evil:\s*$/i.test(pending)) return answer(String(evilIndex));
      if (/Choose World:\s*$/i.test(pending)) return answer('n');
      if (/Choose size:\s*$/i.test(pending)) return answer(String(cfg.autocreate));
      // The difficulty menu is 1-indexed while the config value is 0-indexed.
      if (/Choose difficulty:\s*$/i.test(pending)) return answer(String(cfg.difficulty + 1));
      if (/Enter world name:\s*$/i.test(pending)) return answer(cfg.worldName);
      if (/Enter Seed[^:]*:\s*$/i.test(pending)) return answer(cfg.seed ?? '');

      pending = '';
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => finish(new Error(`World generation could not start: ${err.message}`)));
    child.on('close', () => {
      // Exiting on its own is only success if a world actually appeared.
      if (settled) return;
      if (existingWorldFile(serverDir)) return finish();
      finish(new Error('Terraria exited during world generation without producing a world.'));
    });

    // The only detector for a wedged prompt: it produces no output at all.
    const timer = setTimeout(() => {
      finish(new Error(
        'Timed out generating the Terraria world. The server may be waiting at a prompt it was not expecting.'
      ));
    }, spec.worldgenTimeoutMs ?? 15 * 60 * 1000);
  });
}

/* ------------------------------------------------------------------------- */
/* Log line classification                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Terraria writes a `": "` prompt with **no trailing newline**, so whether it
 * glues itself onto the next line depends on where the stdout chunk boundary
 * lands. At 1.4.4.9 the ready line arrived as `": Server started"`; at 1.4.5.6
 * it arrived bare, with `": "` turning up later on its own. Every matcher below
 * therefore strips an *optional* prefix. See plan.md §6 Finding 1.
 */
function strip(line: string): string {
  // Repeated, not just one: when two commands complete inside a single stdout
  // chunk the prompts concatenate, and `": : "` reached the console before this
  // was a `+`.
  return line.replace(/^(:\s*)+/, '').trim();
}

/** World generation progress: `60.3% - Smoothing the world - 0.0%`. */
const WORLDGEN_PROGRESS = /^\d+(\.\d+)?% - .+ - \d+(\.\d+)?%$/;

/**
 * The other progress shape, which the two-percent pattern above misses:
 * `Resetting game objects 96%`, `Validating world save: 24%`. Anchored to
 * "words then a percentage and nothing else" so real lines — `Listening on port
 * 7777`, `Server started` — never match.
 */
const LABELLED_PROGRESS = /^[A-Za-z][A-Za-z .'-]*:?\s*\d+(\.\d+)?%$/;

export function isTerrariaNoiseLine(line: string): boolean {
  const text = strip(line);
  // Nothing left once the prompts are removed. Covers blank lines, `": "`, and
  // runs like `": : "` — otherwise the prompt is the commonest line in the console.
  if (text === '') return true;
  return WORLDGEN_PROGRESS.test(text) || LABELLED_PROGRESS.test(text);
}

export function isTerrariaReadyLine(line: string): boolean {
  return /^Server started/.test(strip(line));
}

/**
 * Join/leave from a log line.
 *
 * The strings come from Terraria's own localization table (`LegacyMultiplayer.19`
 * / `.20` / `ClientWasBooted`), which is why `language=en/US` is pinned and not
 * user-editable. Terraria has no UUID analogue — players are identified by name
 * only.
 */
export function parseTerrariaPresenceLine(line: string): PresenceEvent | null {
  const text = strip(line);

  const joined = text.match(/^(.+) has joined\.$/);
  if (joined) return { type: 'join', username: joined[1] };

  const left = text.match(/^(.+) has left\.$/);
  if (left) return { type: 'leave', username: left[1] };

  const booted = text.match(/^(.+) was booted: /);
  if (booted) return { type: 'leave', username: booted[1] };

  return null;
}

/* ------------------------------------------------------------------------- */

export const terraria: GameDefinition = {
  id: Game.TERRARIA,
  label: 'Terraria',

  async ensureBinary(_serverDir: string, _spec: GameServerSpec): Promise<string> {
    return ensureTerrariaBinary(TERRARIA_VERSION);
  },

  async prepareWorld(serverDir, binaryPath, spec, log) {
    // Idempotent: once a world exists there is nothing to generate, and this is
    // called on every start.
    if (existingWorldFile(serverDir)) return;
    log('Generating world — this takes about 15 seconds for a small world, longer for a large one.');
    await generateTerrariaWorld(serverDir, binaryPath, spec, log);
    log('World generated.');
  },

  prepareServerDir: prepareTerrariaServerDir,

  buildLaunch(serverDir: string, binaryPath: string, _spec: GameServerSpec): LaunchSpec {
    return {
      command: binaryPath,
      args: ['-config', serverConfigPath(serverDir)],
      // The one thing the shell wrapper does that matters; we spawn the binary
      // directly (see launcherPath) so we have to set it ourselves.
      env: { MONO_IOMAP: 'all' },
    };
  },

  stopCommand: 'exit',
  saveCommand: 'save',

  /**
   * Verified against a live 1.4.5.6 server's own `help` output:
   *
   *   kick <player>   Kicks a player from the server.
   *   ban <player>    Bans a player from the server.
   *
   * Both take **only** a name. Appending a reason the way Minecraft does makes
   * Terraria look for a player called "steve Kicked by administrator", find
   * nobody, and do nothing at all — with no error to explain why.
   */
  playerCommand(action, username) {
    if (action === 'kick') return `kick ${username}`;
    if (action === 'ban') return `ban ${username}`;
    // No operator system: `op` answers "Invalid command."
    return null;
  },

  // Everything Terraria owns lives under `worlds/`; the binary stays in the
  // shared cache and is never inside the server directory.
  restoreClearDirs: ['worlds'],

  isReadyLine: isTerrariaReadyLine,
  isNoiseLine: isTerrariaNoiseLine,
  parsePresenceLine: parseTerrariaPresenceLine,

  /**
   * Generous because world generation is the slow part and scales with world
   * size — a small world took ~14 s in the spike, and large worlds are several
   * times that. The timeout exists to catch the `Choose World: ` hang, which
   * produces no output whatsoever, so it only has to be shorter than "forever".
   */
  readyTimeoutMs: 10 * 60 * 1000,

  capabilities: GAME_CAPABILITIES[Game.TERRARIA],
  defaults: { memoryMb: 1024, cpuLimit: 1.0 },
};
