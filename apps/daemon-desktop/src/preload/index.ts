import { contextBridge, ipcRenderer } from 'electron';
import type { AppInfo, DaemonStatus, DockerStatus, LogLine, NodeConfig, UpdateStatus } from '../shared-types';

/*
 * The renderer runs with contextIsolation on and no Node access. Everything it can
 * do is listed here, so the UI cannot reach the filesystem or spawn anything itself.
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  readConfig: (): Promise<NodeConfig> => ipcRenderer.invoke('config:read'),
  writeConfig: (patch: Partial<NodeConfig>): Promise<NodeConfig> => ipcRenderer.invoke('config:write', patch),
  regenerateApiKey: (): Promise<string> => ipcRenderer.invoke('config:regenerate-key'),
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
