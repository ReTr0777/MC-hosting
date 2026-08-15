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

export type DockerState = 'ok' | 'not-running' | 'not-installed' | 'checking';

export interface DockerStatus {
  state: DockerState;
  /** Docker Engine version string when reachable. */
  version: string | null;
  detail: string;
}

export interface NodeConfig {
  port: number;
  apiKey: string;
  frpServerAddr: string;
  frpServerPort: number;
  frpToken: string;
  enabledGames: string[];
  dataDir: string;
}

export interface AppInfo {
  version: string;
  /** Where config.json and the server data directory live. */
  dataRoot: string;
  /** LAN addresses the panel can reach this node on. */
  addresses: string[];
  hostname: string;
  autoStart: boolean;
  availableGames: { id: string; label: string }[];
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'downloading' | 'installing' | 'error';
  /** The version being fetched, when known. */
  version: string | null;
  /** Download progress 0-100 while downloading. */
  percent: number | null;
}

export interface LogLine {
  ts: number;
  stream: 'out' | 'err' | 'app';
  text: string;
}
