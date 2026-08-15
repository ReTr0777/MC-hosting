import { Game, GameCapabilities, TerrariaConfig } from '@mc-manager/shared';

/**
 * Everything the daemon needs to run one non-Minecraft game.
 *
 * Note there is deliberately no Minecraft definition. Minecraft keeps the code
 * path it already has, byte for byte; this registry only answers for games that
 * opted in. See plan.md §2 — the point of the seam is that adding a game cannot
 * change how Minecraft starts.
 */

/** The subset of the create DTO a game module actually needs. */
export interface GameServerSpec {
  serverId: string;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  gameConfig?: TerrariaConfig;
  /** Overrides the default ceiling on one-time world generation. Tests use it. */
  worldgenTimeoutMs?: number;
}

export type PlayerAction = 'op' | 'deop' | 'kick' | 'ban';

export interface PresenceEvent {
  type: 'join' | 'leave';
  /**
   * Player name. Terraria has no UUID analogue — it identifies players by name
   * only — so this is all the presence tracking can ever carry.
   */
  username: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface GameDefinition {
  id: Exclude<Game, Game.MINECRAFT>;
  label: string;

  /** Ensures the server binary exists on disk; returns the executable path. */
  ensureBinary(serverDir: string, spec: GameServerSpec): Promise<string>;

  /**
   * One-time work that must happen before the server can start for the first
   * time, such as generating a world.
   *
   * Runs before `prepareServerDir` and only when there is something to do —
   * implementations must be a no-op once their work exists on disk, because
   * this is called on every start. `log` forwards progress to the console so a
   * slow first boot does not look like a hang.
   */
  prepareWorld?(
    serverDir: string,
    binaryPath: string,
    spec: GameServerSpec,
    log: (line: string) => void
  ): Promise<void>;

  /**
   * Writes the config files needed before the first boot.
   *
   * Load-bearing, not a convenience: a Terraria server launched without a
   * complete config sits at an interactive world-selection prompt forever,
   * emitting no newline, so nothing downstream can detect it. See plan.md §6.
   */
  prepareServerDir(serverDir: string, spec: GameServerSpec): Promise<void>;

  buildLaunch(serverDir: string, binaryPath: string, spec: GameServerSpec): LaunchSpec;

  /** Console command for a graceful shutdown. Minecraft's is `stop`; Terraria's is `exit`. */
  stopCommand: string;

  /** Console command that flushes world state to disk. Minecraft's is `save-all`. */
  saveCommand: string;

  /**
   * The console command for a moderation action, or **null** when the game has
   * no such concept.
   *
   * Null is meaningful and must be handled: Terraria has no operator system at
   * all, and sending `op <name>` to it produces "Invalid command." — which looks
   * to the user like the button silently doing nothing.
   */
  playerCommand(action: PlayerAction, username: string, reason?: string): string | null;

  /**
   * Directories wiped before a restore unpacks over them, so stale files from
   * the previous world cannot survive underneath the restored one.
   *
   * Declared per game because the answer is entirely game-specific — Minecraft's
   * is `world`/`mods`/`config`, Terraria's is just `worlds`. Getting this wrong
   * silently leaves the old world in place.
   */
  restoreClearDirs: string[];

  /** True when this log line means "booted and accepting connections". */
  isReadyLine(line: string): boolean;

  /**
   * True for lines that should never reach the console ring buffer — Terraria's
   * world generation emits thousands of progress lines in seconds and would
   * evict every genuine startup line. See plan.md §6 Finding 4.
   */
  isNoiseLine(line: string): boolean;

  parsePresenceLine(line: string): PresenceEvent | null;

  /** How long to wait for `isReadyLine` before failing loudly. */
  readyTimeoutMs: number;

  capabilities: GameCapabilities;
  defaults: { memoryMb: number; cpuLimit: number };
}
