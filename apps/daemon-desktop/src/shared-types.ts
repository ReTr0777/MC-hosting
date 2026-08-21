/** Types shared between the main process, the preload bridge and the renderer. */

export type DaemonState = 'stopped' | 'starting' | 'running' | 'crashed';

export interface DaemonStatus {
  state: DaemonState;
  /** Populated only while running. */
  pid: number | null;
  port: number;
  /** Set when the daemon exited on its own; cleared on the next successful start. */
  lastError: string | null;
  /** Wall-clock ms since the current run began, or null when not running. */
  uptimeMs: number | null;
}

export type DockerState = 'ok' | 'not-running' | 'not-installed' | 'checking' | 'starting';

export interface DockerStatus {
  state: DockerState;
  /** Docker Engine version string when reachable. */
  version: string | null;
  detail: string;
}

export interface NodeConfig {
  port: number;
  apiKey: string;
  /** Launch Docker Desktop when this app starts. On by default: a node without it hosts nothing. */
  startDockerWithApp: boolean;
  /** Set once the first-run wizard has been through. Its absence is what opens the wizard. */
  setupCompleted: boolean;
  /** The panel this node has joined, when it joined one with a setup code. */
  panelUrl: string;
  /** What that panel calls this node, so the app can say more than "connected". */
  nodeName: string;
  frpServerAddr: string;
  frpServerPort: number;
  frpToken: string;
  /** Tunnel-server port that maps back to this node's API; 0 when not published. */
  frpApiRemotePort: number;
  enabledGames: string[];
  dataDir: string;
}

/** What a machine tells the panel about itself when redeeming a setup code. */
export interface EnrollSubmission {
  code: string;
  apiKey: string;
  port: number;
  hostname: string;
  /** Addresses the panel might reach this machine on directly, best first. */
  addresses: string[];
  enabledGames: string[];
  /** How much of the machine it may hand out to servers — not necessarily all of it. */
  memoryMb: number;
  cpuCores: number;
  agentVersion: string;
}

/**
 * The panel's answer: which node this became, and how it will be reached.
 *
 * `tunnel` is present when the panel could not reach this machine directly and published
 * it through the installation's FRP server instead — the normal case for a home PC behind
 * NAT. The app writes those settings and restarts, which is what actually opens the route.
 */
export interface EnrollResult {
  node: { id: string; name: string; host: string; port: number };
  tunnel: { serverAddr: string; serverPort: number; token: string; apiRemotePort: number } | null;
  reachability: 'direct' | 'tunnel' | 'unverified';
  panelUrl: string;
}

export interface AppInfo {
  version: string;
  /** What this machine has, so the wizard can suggest what to hand out rather than ask blind. */
  machineMemoryMb: number;
  machineCpuCores: number;
  /** Where config.json and the server data directory live. */
  dataRoot: string;
  /** LAN addresses the panel can reach this node on. */
  addresses: string[];
  hostname: string;
  autoStart: boolean;
  availableGames: { id: string; label: string }[];
}

export interface UpdateStatus {
  /** 'available' means found and waiting on the node hoster to accept it. */
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
  /** The version offered or being fetched, when known. */
  version: string | null;
  /** Download progress 0-100 while downloading. */
  percent: number | null;
}

export interface LogLine {
  ts: number;
  stream: 'out' | 'err' | 'app';
  text: string;
}
