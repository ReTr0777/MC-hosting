import { ServerType, ExecutionMode, Game } from './enums';
import { TerrariaConfig } from './games';

export interface CreateServerContainerDto {
  serverId: string;
  /**
   * Which game this server runs.
   *
   * Optional on purpose. Every caller that predates this field — including the
   * Discord bot's `runServerAction` and the daemon's own saved
   * `craftcontrol-meta.json` files — keeps compiling and keeps meaning
   * Minecraft, and the daemon's dispatch treats absent as `MINECRAFT`.
   */
  game?: Game;
  /**
   * Game-specific settings. Shape is decided by `game`; ignored for Minecraft,
   * which keeps using `serverType` / `mcVersion`.
   */
  gameConfig?: TerrariaConfig;
  /** Minecraft-only. Ignored when `game` is anything else. */
  serverType: ServerType;
  /** Minecraft-only. Ignored when `game` is anything else. */
  mcVersion: string;
  modpackSlug?: string;
  modId?: number;
  fileId?: number;
  serverPort: number;
  /** Host port published to BlueMap's web server (container port 8100). */
  bluemapPort?: number;
  memoryMb: number;
  cpuLimit: number;
  eulaAccepted: boolean;
  isMigration?: boolean;
  executionMode?: ExecutionMode;
}

export interface DaemonHealthDto {
  status: string;
  uptime: number;
  cpuUsage: number;
  memoryUsage: {
    used: number;
    total: number;
    free: number;
    swapUsed: number;
    swapTotal: number;
  };
  dockerAvailable: boolean;
  diskUsage?: {
    used: number;
    total: number;
    free: number;
    usedPercent: number;
    mount: string;
  }[];
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  osInfo?: {
    platform: string;
    distro: string;
    arch: string;
    kernel: string;
    hostname: string;
  };
  cpuTemp?: number | null;
  networkInterfaces?: {
    iface: string;
    ip4: string;
    speed: number;
    rx_sec: number;
    tx_sec: number;
  }[];
  /**
   * Games this node is configured to host.
   *
   * Optional on purpose: a daemon older than this field omits it entirely, and
   * the panel must read that as "no opinion, leave the stored list alone"
   * rather than as "this node hosts nothing".
   */
  enabledGames?: Game[];
  /**
   * Newest Java major version this node can run, or null if none could be read.
   *
   * A capability, not the JDK any particular server would get. The panel compares it
   * against what a server needs before migrating one here, so that a move cannot
   * strand a server on a node whose JVM is too old to start it.
   *
   * Optional for the same reason as enabledGames: an older daemon omits it, and the
   * panel must read that as "unknown" rather than as "no Java".
   */
  javaMajor?: number | null;
}

export interface WsAuthPayload {
  auth: string;
}

export interface WsIncomingMessage {
  event: 'auth' | 'command';
  data?: string;
  auth?: string;
}

export interface WsOutgoingMessage {
  event: 'authenticated' | 'log' | 'status' | 'error';
  data?: string;
  message?: string;
}
