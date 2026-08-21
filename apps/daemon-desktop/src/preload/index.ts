import { contextBridge, ipcRenderer } from 'electron';
import type { AppInfo, DaemonStatus, DockerStatus, EnrollResult, LogLine, NodeConfig, UpdateStatus } from '../shared-types';

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
