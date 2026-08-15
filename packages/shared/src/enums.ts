export enum GlobalRole {
  GLOBAL_ADMIN = 'GLOBAL_ADMIN',
  USER = 'USER',
}

export enum ServerRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  OPERATOR = 'OPERATOR',
  VIEWER = 'VIEWER',
}

export enum ServerStatus {
  OFFLINE = 'OFFLINE',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  INSTALLING = 'INSTALLING',
  ERROR = 'ERROR',
}

export enum ServerType {
  VANILLA = 'VANILLA',
  FABRIC = 'FABRIC',
  FORGE = 'FORGE',
  PAPER = 'PAPER',
  PURPUR = 'PURPUR',
  MODRINTH = 'MODRINTH',
  CURSEFORGE = 'CURSEFORGE',
}

export enum ExecutionMode {
  CONTAINER = 'CONTAINER',
  PROCESS = 'PROCESS',
}

/**
 * Games a node can be made available for.
 *
 * Deliberately its own axis rather than more `ServerType` members: `ServerType`
 * answers "which Minecraft flavour", and every value in it is meaningless for
 * anything that is not Minecraft.
 */
export enum Game {
  MINECRAFT = 'MINECRAFT',
  TERRARIA = 'TERRARIA',
}

/** Display names for the setup GUI and the panel's node picker. */
export const GAME_LABELS: Record<Game, string> = {
  [Game.MINECRAFT]: 'Minecraft',
  [Game.TERRARIA]: 'Terraria',
};

export const ALL_GAMES: Game[] = Object.values(Game);

/**
 * What a node advertises when it has never been told otherwise — including
 * every node that predates the setting. Minecraft-only keeps existing
 * deployments behaving exactly as they do today.
 *
 * This stays Minecraft-only no matter how many games join the enum: a node
 * gains a game because its operator ticked the box, never because the panel
 * was upgraded underneath them.
 */
export const DEFAULT_ENABLED_GAMES: Game[] = [Game.MINECRAFT];

export function isGame(value: unknown): value is Game {
  return typeof value === 'string' && (ALL_GAMES as string[]).includes(value);
}

/**
 * Coerce untrusted input (daemon config file, HTTP body) into a valid,
 * de-duplicated game list. Returns `null` when nothing usable is left, so
 * callers can distinguish "no opinion" from "explicitly empty" — an older
 * daemon that reports nothing must never be read as "runs no games".
 */
export function parseGameList(value: unknown): Game[] | null {
  if (!Array.isArray(value)) return null;
  const games = Array.from(new Set(value.filter(isGame)));
  return games.length > 0 ? games : null;
}

