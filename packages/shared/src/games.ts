import { Game } from './enums';

/**
 * What a game supports, as one flat set of flags.
 *
 * This lives in `shared` rather than in the daemon's game registry so the panel
 * gates its tabs off exactly the same values the daemon dispatches on — a tab
 * that is visible but backed by nothing is the failure mode this prevents.
 *
 * Minecraft's entry describes what the panel already does today. It is
 * descriptive, not a switch: no Minecraft code path reads it, so changing a
 * flag here cannot turn a Minecraft feature off.
 */
export interface GameCapabilities {
  /** The console accepts typed commands (the process has a usable stdin). */
  consoleInput: boolean;
  /** A live player list can be produced. */
  players: boolean;
  /** Players can be granted operator rights. Terraria has no operator concept at all. */
  playerOp: boolean;
  /** Individual players can be kicked from the console. */
  playerKick: boolean;
  /** Individual players can be banned from the console. */
  playerBan: boolean;
  whitelist: boolean;
  /**
   * A ban *list* exists that the panel can show and edit — distinct from
   * `playerBan`, which is only the act of banning someone.
   */
  bans: boolean;
  /**
   * When set, the ban list is a flat text file of this name rather than
   * Minecraft's structured `banned-players.json` / `banned-ips.json` pair, and
   * the panel shows a line-based editor instead. Null means the structured
   * Minecraft route.
   */
  banFile: string | null;
  /** Mod/plugin management: Modrinth, CurseForge, mrpack, ServerPackCreator. */
  mods: boolean;
  /**
   * `.tmod` mod management: upload, enable/disable, delete.
   *
   * Deliberately not the `mods` flag above. That one means Minecraft's whole
   * content stack — a Modrinth search, version resolution, pack health — and
   * turning it on for Terraria would light up UI backed by nothing. tModLoader
   * shares none of it: mods are files you place, and the browser is Steam's.
   *
   * True means "this game has a .tmod system at all", which is a property of the
   * game. Whether a *given server* has one depends on its variant, since only
   * tModLoader loads mods — see terrariaSupportsMods.
   */
  tmodMods: boolean;
  /** Filename of the editable `key=value` server config, or null if there is none. */
  configFile: string | null;
  /** BlueMap-style live world map. */
  worldMap: boolean;
  /** Sleep on empty / wake on join. */
  sleepWake: boolean;
  /** Velocity subdomain routing. */
  subdomain: boolean;
  /** Version update engine. */
  updateEngine: boolean;
  /** Modpack health checks. */
  packHealth: boolean;
}

export const GAME_CAPABILITIES: Record<Game, GameCapabilities> = {
  [Game.MINECRAFT]: {
    consoleInput: true,
    players: true,
    playerOp: true,
    playerKick: true,
    playerBan: true,
    whitelist: true,
    bans: true,
    banFile: null,
    mods: true,
    tmodMods: false,
    configFile: 'server.properties',
    worldMap: true,
    sleepWake: true,
    subdomain: true,
    updateEngine: true,
    packHealth: true,
  },
  [Game.TERRARIA]: {
    consoleInput: true,
    players: true,
    // `op` is not a Terraria command at all — the server answers "Invalid command."
    playerOp: false,
    // Both exist, but take only a name: `kick <player>` / `ban <player>`.
    playerKick: true,
    playerBan: true,
    whitelist: false,
    // Terraria does keep a ban list — just a flat file rather than Minecraft's
    // JSON pair, which is why it was invisible until now.
    bans: true,
    banFile: 'banlist.txt',
    mods: false,
    tmodMods: true,
    configFile: 'serverconfig.txt',
    worldMap: false,
    sleepWake: false,
    subdomain: false,
    updateEngine: false,
    packHealth: false,
  },
};

export function getGameCapabilities(game: Game): GameCapabilities {
  return GAME_CAPABILITIES[game];
}

/**
 * Terraria's special world-generation modes.
 *
 * In the game these are triggered by typing a magic phrase as the seed. The
 * dedicated server also has `seed_<name>=1` config keys, but we do not use
 * them: the world evil can only be chosen through the interactive creation
 * prompts, so the daemon drives those anyway — and that menu offers Skyblock,
 * which has no config key at all.
 *
 * `menuIndex` is the number the daemon types at that menu. Index 1 is "Normal",
 * so no entry here may claim it.
 *
 * All of them are **decided when the world is generated and can never be
 * changed afterwards**, which is why they belong in the create wizard rather
 * than the settings tab.
 */
export const TERRARIA_SECRET_SEEDS = [
  { id: 'fortheworthy', menuIndex: 6, label: 'For the Worthy', help: 'Brutally hard. Enemies hit harder and the world is hostile from the start.' },
  { id: 'notthebees', menuIndex: 2, label: 'Not the Bees', help: 'The world is almost entirely jungle and honey.' },
  { id: 'theconstant', menuIndex: 5, label: 'The Constant', help: "A Don't Starve crossover — darkness itself is lethal." },
  { id: 'celebration', menuIndex: 4, label: 'Celebration Mk 10', help: 'Terraria anniversary world. Extra loot and party themes.' },
  { id: 'notraps', menuIndex: 7, label: 'No Traps', help: 'Removes the usual traps — and replaces them with worse ones.' },
  { id: 'remix', menuIndex: 8, label: 'Remix', help: 'The world is turned upside down: hell above, sky below.' },
  { id: 'drunk', menuIndex: 3, label: 'Drunk World', help: 'Both evil biomes, both ore sets, and a great deal of chaos.' },
  { id: 'zenith', menuIndex: 9, label: 'Zenith', help: 'Every secret seed at once. Extremely chaotic.' },
  { id: 'skyblock', menuIndex: 10, label: 'Skyblock', help: 'Start on a tiny floating island with almost nothing.' },
] as const;

/**
 * Which evil biome the world generates with.
 *
 * There is **no config key and no command-line flag** for this — the dedicated
 * server only asks for it through its interactive world-creation prompts, which
 * is why the daemon drives those prompts rather than using `autocreate`.
 */
export const TERRARIA_WORLD_EVILS = [
  { id: 'RANDOM', menuIndex: 1, label: 'Random', help: 'Let the world roll for it.' },
  { id: 'CORRUPTION', menuIndex: 2, label: 'Corruption', help: 'The classic purple evil — Eater of Worlds, shadow orbs.' },
  { id: 'CRIMSON', menuIndex: 3, label: 'Crimson', help: 'The red evil — Brain of Cthulhu, crimson hearts.' },
] as const;

export type TerrariaWorldEvil = (typeof TERRARIA_WORLD_EVILS)[number]['id'];

const WORLD_EVIL_IDS: string[] = TERRARIA_WORLD_EVILS.map((e) => e.id);

export type TerrariaSecretSeed = (typeof TERRARIA_SECRET_SEEDS)[number]['id'];

const SECRET_SEED_IDS: string[] = TERRARIA_SECRET_SEEDS.map((s) => s.id);

/**
 * Terraria's per-server settings.
 *
 * These live in `Server.gameConfig` rather than in dedicated columns because
 * every one of them is meaningless for Minecraft — and because the alternative,
 * widening `ServerType`, would put Terraria values in front of code that only
 * ever expects Minecraft loaders.
 *
 * `language` is deliberately absent: the daemon pins `en-US` because presence
 * parsing reads Terraria's localized join/leave strings, and a user-chosen
 * language would silently break the player list.
 */
export const TERRARIA_VARIANTS = ['VANILLA', 'TSHOCK', 'TMODLOADER'] as const;
export type TerrariaVariant = (typeof TERRARIA_VARIANTS)[number];

/**
 * Whether a Terraria server of this variant can load mods.
 *
 * Vanilla ignores a Mods folder entirely, so offering mod management on one would
 * be a tab where every upload does nothing — which reads as a broken panel rather
 * than as an unsupported variant.
 */
export function terrariaSupportsMods(variant: TerrariaVariant | undefined | null): boolean {
  return variant === 'TMODLOADER';
}

/**
 * Terraria dedicated-server builds the panel offers.
 *
 * terraria.org publishes no index and no "latest" endpoint — probing the download URL is
 * the only way to discover what exists — so this list is what somebody chose, tested and
 * wrote down. Newest first; the first entry is the default for a new server.
 */
export const TERRARIA_VERSIONS = ['1.4.5.6', '1.4.4.9'] as const;

/**
 * tModLoader builds the panel offers, and the Terraria version each one is built against.
 *
 * The pairing is the point. tModLoader tracks an older Terraria than vanilla ships: the
 * 2026.06 series is Terraria 1.4.4.9 while vanilla is already on 1.4.5.6. A world
 * generated by the newer binary is a newer world format than tModLoader expects, so
 * worldgen for a modded server has to use the version in `terraria` here rather than
 * whatever vanilla happens to be pinned at.
 *
 * A `.tmod` is also compiled against a specific tModLoader series and refuses to load on
 * another, so changing this on a server with mods installed means replacing those mods.
 */
export const TMODLOADER_BUILDS = [
  { version: '2026.06.3.6', terraria: '1.4.4.9', label: '2026.06 (Terraria 1.4.4.9)' },
] as const;

export type TmodloaderBuild = (typeof TMODLOADER_BUILDS)[number];

export const DEFAULT_TERRARIA_VERSION = TERRARIA_VERSIONS[0];
export const DEFAULT_TMODLOADER_VERSION = TMODLOADER_BUILDS[0].version;

/**
 * The Terraria version a given tModLoader build is built against, for worldgen.
 *
 * Falls back to the default build's pairing rather than to the newest vanilla: an unknown
 * tModLoader version is far more likely to be near the ones listed than to match whatever
 * vanilla has moved on to.
 */
export function terrariaVersionForTmodloader(tmodloaderVersion: string | undefined | null): string {
  const known = TMODLOADER_BUILDS.find((b) => b.version === tmodloaderVersion);
  return (known ?? TMODLOADER_BUILDS[0]).terraria;
}

export interface TerrariaConfig {
  /**
   * Which Terraria server to run.
   *
   * TMODLOADER is a different server binary, not a flag on the vanilla one, and
   * it is the only variant that loads mods. TSHOCK is still reserved and not yet
   * implemented.
   */
  variant: TerrariaVariant;
  /**
   * Which build of the chosen variant to run. Unset means the panel's current default,
   * which is what every server created before the picker existed relies on.
   */
  terrariaVersion?: string;
  tmodloaderVersion?: string;
  worldName: string;
  /** World size: 1 small, 2 medium, 3 large. Fixed at generation. */
  autocreate: 1 | 2 | 3;
  /** 0 classic, 1 expert, 2 master, 3 journey. Fixed at generation. */
  difficulty: 0 | 1 | 2 | 3;
  /**
   * World seed. Empty means Terraria rolls a random one. Fixed at generation.
   * Free text — Terraria also accepts its magic phrases here, though the
   * `secretSeeds` switches below are the reliable way to ask for those.
   */
  seed?: string;
  /** Special generation modes. Fixed at generation. */
  secretSeeds?: TerrariaSecretSeed[];
  /** Which evil biome the world gets. Fixed at generation. */
  evil?: TerrariaWorldEvil;

  maxPlayers: number;
  password?: string;
  motd?: string;
  /** Terraria's extra cheat protection (`secure=1`). */
  secure?: boolean;
}

export const DEFAULT_TERRARIA_CONFIG: TerrariaConfig = {
  variant: 'VANILLA',
  worldName: 'World',
  autocreate: 2,
  difficulty: 0,
  maxPlayers: 8,
  secure: true,
  evil: 'RANDOM',
};

/** Terraria's own ceiling; the server refuses to start above it. */
export const TERRARIA_MAX_PLAYERS = 255;

/**
 * Coerce untrusted input into a usable `TerrariaConfig`.
 *
 * Every field falls back to its default rather than rejecting the whole object.
 * The reason is §6's first-boot trap: an incomplete `serverconfig.txt` leaves
 * the server sitting at an interactive prompt forever with no output to detect
 * it from, so "always produce a complete config" is worth more here than
 * "faithfully report which field was wrong".
 */
function isVersionish(value: unknown): boolean {
  return typeof value === 'string' && /^\d+(\.\d+){1,3}$/.test(value.trim());
}

export function parseTerrariaConfig(value: unknown): TerrariaConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  const worldName = typeof raw.worldName === 'string' ? raw.worldName.trim() : '';
  const autocreate = Number(raw.autocreate);
  const difficulty = Number(raw.difficulty);
  const maxPlayers = Number(raw.maxPlayers);
  const password = typeof raw.password === 'string' && raw.password.length > 0 ? raw.password : undefined;
  const seed = typeof raw.seed === 'string' && raw.seed.trim().length > 0 ? raw.seed.trim() : undefined;
  const motd = typeof raw.motd === 'string' && raw.motd.trim().length > 0 ? raw.motd.trim() : undefined;

  const secretSeeds = Array.isArray(raw.secretSeeds)
    ? (Array.from(new Set(raw.secretSeeds.filter((s): s is TerrariaSecretSeed =>
        typeof s === 'string' && SECRET_SEED_IDS.includes(s)))))
    : [];

  return {
    // Unrecognised falls back to VANILLA rather than throwing: a config written by a
    // newer panel must not make an older one refuse to read the server at all.
    variant:
      typeof raw.variant === 'string' && (TERRARIA_VARIANTS as readonly string[]).includes(raw.variant)
        ? (raw.variant as TerrariaVariant)
        : 'VANILLA',
    // Version-shaped or dropped. These become part of a download URL, and a value that is
    // not a version produces a 404 at first start rather than anything explicable.
    ...(isVersionish(raw.terrariaVersion) ? { terrariaVersion: String(raw.terrariaVersion).trim() } : {}),
    ...(isVersionish(raw.tmodloaderVersion) ? { tmodloaderVersion: String(raw.tmodloaderVersion).trim() } : {}),
    worldName: worldName || DEFAULT_TERRARIA_CONFIG.worldName,
    autocreate: ([1, 2, 3] as number[]).includes(autocreate)
      ? (autocreate as 1 | 2 | 3)
      : DEFAULT_TERRARIA_CONFIG.autocreate,
    difficulty: ([0, 1, 2, 3] as number[]).includes(difficulty)
      ? (difficulty as 0 | 1 | 2 | 3)
      : DEFAULT_TERRARIA_CONFIG.difficulty,
    maxPlayers: Number.isFinite(maxPlayers) && maxPlayers >= 1
      ? Math.min(Math.floor(maxPlayers), TERRARIA_MAX_PLAYERS)
      : DEFAULT_TERRARIA_CONFIG.maxPlayers,
    // Defaults to on, and only an explicit `false` turns it off — a config that
    // simply predates the field keeps the protection rather than losing it.
    secure: raw.secure !== false,
    // Anything unrecognised means "let the world decide", which is what a server
    // that never specified one has always done.
    evil: typeof raw.evil === 'string' && WORLD_EVIL_IDS.includes(raw.evil)
      ? (raw.evil as TerrariaWorldEvil)
      : 'RANDOM',
    ...(seed ? { seed } : {}),
    ...(secretSeeds.length ? { secretSeeds } : {}),
    ...(password ? { password } : {}),
    ...(motd ? { motd } : {}),
  };
}
