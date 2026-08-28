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
  /**
   * Whether this server's backups are copied to the node's off-site storage.
   *
   * Optional, and absent means **on**. Every server that existed before this field had its
   * backups uploaded whenever the node had off-site storage configured, and a saved
   * craftcontrol-meta.json written before it must keep meaning exactly that — reading
   * absent as "off" would quietly stop backups leaving the node for every one of them.
   * New servers are created with the field set explicitly, so only pre-existing servers
   * ever fall back to the default.
   */
  offsiteBackups?: boolean;
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
  /**
   * How much of this machine its owner is willing to hand out to servers.
   *
   * Distinct from memoryUsage.total, which is what the hardware has. A node running on
   * somebody's own PC is usually not offered whole: the panel budgets placements against
   * this, so a machine capped at 8 of its 32 GB stops accepting servers at 8 rather than
   * competing with the games its owner is playing.
   *
   * Absent from a node that predates the setting, which the panel reads as "all of it".
   */
  allowance?: {
    memoryMb: number;
    /**
     * Logical processors, i.e. threads — the same unit as `docker run --cpus` and as a
     * server's own cpuLimit, not the physical core count in `cpuCores` above.
     *
     * Named for the unit rather than for the hardware on purpose. On an SMT chip the two
     * differ by a factor of two, and a field called cpuCores holding 16 next to another
     * called cpuCores holding 8 is a bug waiting to be written.
     */
    cpus: number;
    /** False when the figures above are simply the whole machine, so nothing was capped. */
    capped: boolean;
  };
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
  /**
   * Free and total space on the filesystem holding the data directory, in MB.
   *
   * Not the same question as diskUsage, which lists mounts without saying which one
   * servers are written to. The panel checks this before streaming a world here, so it
   * has to be the disk that will actually receive it. Null when it could not be read.
   */
  dataDiskFreeMb?: number | null;
  dataDiskTotalMb?: number | null;
  /**
   * The daemon's own package version, e.g. "1.2.15".
   *
   * Optional because a daemon predating this field omits it, and the panel has to read
   * that as "too old to say" rather than as "no version" — see daemonVersionState.
   */
  version?: string;
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
