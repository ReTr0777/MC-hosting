import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  DaemonStatus,
  DockerStatus,
  EnrollResult,
  LogLine,
  MoveDataResult,
  NodeConfig,
  StorageInfo,
  UpdateStatus,
} from '../shared-types';

/*
 * The renderer runs with contextIsolation on and no Node access. Everything it can
 * do is listed here, so the UI cannot reach the filesystem or spawn anything itself.
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  readConfig: (): Promise<NodeConfig> => ipcRenderer.invoke('config:read'),
  writeConfig: (patch: Partial<NodeConfig>): Promise<NodeConfig> => ipcRenderer.invoke('config:write', patch),
  regenerateApiKey: (): Promise<string> => ipcRenderer.invoke('config:regenerate-key'),
  /** Joins a panel with a setup code, registering this machine as a node of its own. */
  enroll: (
    panelUrl: string,
    code: string,
    limits?: { memoryMb?: number; cpuCores?: number }
  ): Promise<EnrollResult> => ipcRenderer.invoke('config:enroll', panelUrl, code, limits),
  /** Progress while the panel is being asked whether it can see this machine. */
  onEnrollProgress: (cb: (message: string) => void): void => {
    ipcRenderer.on('enroll:progress', (_e, message: string) => cb(message));
  },
  /** Marks the first-run wizard finished, so it does not reappear. */
  completeSetup: (): Promise<NodeConfig> => ipcRenderer.invoke('config:complete-setup'),
  importConfig: (): Promise<{ imported: boolean; nodeName?: string | null; panelUrl?: string | null }> =>
    ipcRenderer.invoke('config:import'),

  getStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke('daemon:status'),
  getLogs: (): Promise<LogLine[]> => ipcRenderer.invoke('daemon:logs'),
  clearLogs: (): Promise<void> => ipcRenderer.invoke('daemon:clear-logs'),
  start: (): Promise<void> => ipcRenderer.invoke('daemon:start'),
  stop: (): Promise<void> => ipcRenderer.invoke('daemon:stop'),
  restart: (): Promise<void> => ipcRenderer.invoke('daemon:restart'),

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  checkForUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),
  /** Takes the update the node hoster was offered — including one they deferred. */
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (s: UpdateStatus) => void): void => {
    ipcRenderer.on('update:status', (_e, s: UpdateStatus) => cb(s));
  },

  checkDocker: (): Promise<DockerStatus> => ipcRenderer.invoke('docker:check'),
  openDockerDownload: (): Promise<void> => ipcRenderer.invoke('docker:download'),
  /** Launches Docker Desktop and resolves once the engine answers, or the wait runs out. */
  startDocker: (): Promise<DockerStatus> => ipcRenderer.invoke('docker:start'),
  /** Sets Docker's own "start when you sign in", so a rebooted machine needs nobody. */
  configureDockerAutoStart: (): Promise<{ ok: boolean; changed: boolean; detail: string }> =>
    ipcRenderer.invoke('docker:configure-autostart'),
  onDockerStatus: (cb: (s: DockerStatus) => void): void => {
    ipcRenderer.on('docker:status', (_e, s: DockerStatus) => cb(s));
  },

  /** Whether Windows Firewall lets the panel reach this node's port. */
  getFirewallStatus: (): Promise<{ state: string; detail: string }> => ipcRenderer.invoke('firewall:status'),
  /** Opens the port, prompting for administrator rights. */
  openFirewall: (): Promise<{ ok: boolean; detail: string; status: { state: string; detail: string } }> =>
    ipcRenderer.invoke('firewall:open'),

  /** Where the servers live, how big they are, and how much room is left on that drive. */
  getStorageInfo: (): Promise<StorageInfo> => ipcRenderer.invoke('storage:info'),
  /** Opens the folder picker; null when the user backed out. Nothing is moved yet. */
  chooseStorageDir: (): Promise<{ path: string; ok: boolean; message: string } | null> =>
    ipcRenderer.invoke('storage:choose'),
  /** Stops the agent, moves the data, points the config at it, starts the agent. */
  moveStorageDir: (target: string): Promise<MoveDataResult> => ipcRenderer.invoke('storage:move', target),
  onStorageProgress: (cb: (message: string) => void): void => {
    ipcRenderer.on('storage:progress', (_e, message: string) => cb(message));
  },
  /** Caps what servers may use of this machine. 0 for either means no cap. */
  setLimits: (limits: { maxMemoryMb?: number; maxCpuCores?: number }): Promise<NodeConfig> =>
    ipcRenderer.invoke('limits:set', limits),

  setAutoStart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('app:set-auto-start', enabled),
  openDataDir: (): Promise<void> => ipcRenderer.invoke('app:open-data-dir'),
  openLogFile: (): Promise<void> => ipcRenderer.invoke('app:open-log'),

  onStatus: (cb: (s: DaemonStatus) => void): void => {
    ipcRenderer.on('daemon:status', (_e, s: DaemonStatus) => cb(s));
  },
  onLog: (cb: (l: LogLine) => void): void => {
    ipcRenderer.on('daemon:log', (_e, l: LogLine) => cb(l));
  },
  onLogsCleared: (cb: () => void): void => {
    ipcRenderer.on('daemon:logs-cleared', () => cb());
  },
};

contextBridge.exposeInMainWorld('node', api);

export type NodeApi = typeof api;
