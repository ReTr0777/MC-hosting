import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ConfigStore } from './config-store';
import { DaemonProcess } from './daemon-process';
import { checkDocker, DOCKER_DOWNLOAD_URL } from './docker';
import { FileLogger } from './logger';
import { initAutoUpdates, type UpdaterControls } from './updater';
import type { AppInfo, DaemonStatus, NodeConfig, UpdateStatus } from '../shared-types';

/*
 * Bootstrap trace, written before anything else can fail.
 *
 * app.getPath('userData') is only meaningful once Electron is ready, so the real
 * log cannot exist yet — and a crash between here and there would otherwise leave
 * no evidence at all on a machine with no console attached.
 */
const bootLog = path.join(os.tmpdir(), 'mc-hosting-node-boot.log');
function boot(message: string): void {
  try {
    fs.appendFileSync(bootLog, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* never fatal */
  }
}

boot('main module loaded');

// Only one node agent may own the port and the data directory. A second launch
// should surface the existing window instead of fighting over them.
if (!app.requestSingleInstanceLock()) {
  boot('another instance holds the lock; exiting');
  app.quit();
}

const isPackaged = app.isPackaged;

/**
 * Where the compiled daemon lives: inside app.asar when packaged.
 *
 * It used to ride along as extraResources, i.e. ~7000 loose files under
 * resources/daemon. Auto-updates restored the shallow ones and dropped the whole
 * node_modules tree underneath, leaving an installed node that started and died on
 * "Cannot find module 'express'". app.asar is a single file, which is the one thing
 * an update is guaranteed to replace whole, so the daemon travels inside it —
 * Electron's fs patch makes the archive readable to the forked agent (see
 * daemon-process.ts, which must keep the child's cwd outside it).
 */
const daemonEntry = isPackaged
  ? path.join(app.getAppPath(), 'daemon-runtime', 'index.js')
  : path.join(__dirname, '..', '..', '..', 'daemon', 'dist', 'index.js');

/** Packages the bundle could not inline. Unpackaged, npm has already placed them. */
const daemonModulePath = isPackaged ? path.join(app.getAppPath(), 'daemon-runtime', 'vendor') : null;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: ConfigStore;
let daemon: DaemonProcess;
let log: FileLogger;
let updateStatus: UpdateStatus = { state: 'idle', version: null, percent: null };
/** Set only in packaged builds; there is nothing to update in development. */
let updater: UpdaterControls | null = null;
/** Set on the way out so the close handler stops hiding to tray and lets us exit. */
let quitting = false;

const GAME_LABELS: Record<string, string> = { MINECRAFT: 'Minecraft', TERRARIA: 'Terraria' };

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (/docker|veth|br-|WSL|Loopback/i.test(name)) continue;
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    dataRoot: store.dataRoot,
    addresses: lanAddresses(),
    hostname: os.hostname(),
    autoStart: app.getLoginItemSettings().openAtLogin,
    availableGames: Object.entries(GAME_LABELS).map(([id, label]) => ({ id, label })),
  };
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0f19',
    title: 'MC Hosting Node',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.show());

  // Closing the window must not take the node offline — that is the whole point of
  // running in the tray. Only an explicit Quit stops the agent.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

/**
 * Offers an update and waits for an answer.
 *
 * Parented to the window when there is one, so it cannot end up behind it. When the
 * app is sitting in the tray there is no parent to attach to and the dialog stands on
 * its own — which is the point: a node hoster who never opens the window still gets
 * asked rather than updated silently.
 */
async function promptForUpdate(version: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Update now', 'Not now'],
    defaultId: 0,
    // Esc and the close button both mean "not now", never an accidental restart.
    cancelId: 1,
    title: 'MC Hosting Node',
    message: `Version ${version} is available.`,
    detail:
      `This node is running ${app.getVersion()}.\n\n` +
      'Updating restarts the node agent, so the node shows offline in the panel for a few ' +
      'seconds. Game servers keep running — they are Docker containers and are not part of ' +
      'this app.\n\n' +
      'You can install it later from the app window instead.',
    noLink: true,
  };

  const parent = win && !win.isDestroyed() ? win : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

function buildTrayMenu(status: DaemonStatus): void {
  if (!tray) return;
  const running = status.state === 'running' || status.state === 'starting';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Node: ${status.state}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Control Panel', click: showWindow },
      {
        label: running ? 'Stop node' : 'Start node',
        click: () => {
          if (running) void daemon.stop();
          else daemon.start();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.setToolTip(`MC Hosting Node — ${status.state}`);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  buildTrayMenu(daemon.getStatus());
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => {
    // First call the window makes. Recording it means the log distinguishes "the UI
    // never loaded" from "the UI loaded but something later went wrong".
    log.write('ui', 'control panel connected');
    return appInfo();
  });
  ipcMain.handle('config:read', () => store.read());

  ipcMain.handle('config:write', (_e, patch: Partial<NodeConfig>) => {
    const clean: Record<string, unknown> = {};
    if (typeof patch.port === 'number' && patch.port > 0 && patch.port < 65536) clean.port = patch.port;
    if (typeof patch.frpServerAddr === 'string') clean.frpServerAddr = patch.frpServerAddr.trim();
    if (typeof patch.frpServerPort === 'number') clean.frpServerPort = patch.frpServerPort;
    if (typeof patch.frpToken === 'string') clean.frpToken = patch.frpToken;
    // An empty list would make the node invisible to the panel's picker, with no
    // obvious way to recover from inside the app. Refuse instead of silently fixing.
    if (Array.isArray(patch.enabledGames)) {
      const games = patch.enabledGames.filter((g) => g in GAME_LABELS);
      if (games.length === 0) throw new Error('Select at least one game for this node to host.');
      clean.enabledGames = games;
    }
    store.write(clean);
    return store.read();
  });

  ipcMain.handle('config:regenerate-key', () => store.regenerateApiKey());

  ipcMain.handle('config:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import node config',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Node config', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { imported: false };

    const applied = store.importFile(picked.filePaths[0]);
    log.write('config', `imported config for node "${applied.nodeName ?? 'unnamed'}"`);
    // The daemon reads config.json once at startup, so the new key only takes
    // effect on a restart. Doing it here means "Import" is the whole job.
    await daemon.restart();
    return { imported: true, ...applied };
  });

  ipcMain.handle('daemon:status', () => daemon.getStatus());
  ipcMain.handle('daemon:logs', () => daemon.getLogs());
  ipcMain.handle('daemon:clear-logs', () => daemon.clearLogs());
  ipcMain.handle('daemon:start', () => daemon.start());
  ipcMain.handle('daemon:stop', () => daemon.stop());
  ipcMain.handle('daemon:restart', () => daemon.restart());

  ipcMain.handle('update:status', () => updateStatus);
  // Both no-ops unpackaged, where there is no updater and the UI hides the control.
  ipcMain.handle('update:check', () => updater?.check());
  ipcMain.handle('update:install', () => updater?.installPending());
  ipcMain.handle('docker:check', () => checkDocker());
  ipcMain.handle('docker:download', () => shell.openExternal(DOCKER_DOWNLOAD_URL));

  ipcMain.handle('app:set-auto-start', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('app:open-data-dir', () => shell.openPath(store.dataRoot));
  ipcMain.handle('app:open-log', () => shell.openPath(log.path));
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  boot('electron ready');
  log = new FileLogger(app.getPath('userData'));
  log.write('app', `starting v${app.getVersion()} packaged=${isPackaged}`);
  log.write('app', `daemon entry: ${daemonEntry}`);

  store = new ConfigStore(app.getPath('userData'));
  store.ensureInitialised();

  daemon = new DaemonProcess(
    daemonEntry,
    store.serversDir,
    app.getPath('userData'),
    daemonModulePath,
    () => store.read().port,
    (m) => log.write('daemon', m)
  );
  daemon.on('status', (status: DaemonStatus) => {
    send('daemon:status', status);
    buildTrayMenu(status);
  });
  daemon.on('log', (line) => send('daemon:log', line));
  daemon.on('logs-cleared', () => send('daemon:logs-cleared', null));

  registerIpc();
  createTray();

  // Launched by the login item: come up in the tray without stealing focus.
  const hidden = process.argv.includes('--hidden');
  if (!hidden) createWindow();

  // The node exists to be online, so start the agent straight away. Docker not being
  // ready is surfaced in the UI rather than blocking the attempt.
  daemon.start();

  // Unpackaged builds have no installer to compare against, so a check would only
  // ever log an error.
  if (isPackaged) {
    updater = initAutoUpdates({
      log: (m) => log.write('update', m),
      onStatus: (status) => {
        updateStatus = status;
        send('update:status', status);
      },
      confirmUpdate: promptForUpdate,
      // The installer replaces files under the running agent; stop it first so the
      // update does not race a live process holding them open.
      beforeInstall: async () => {
        quitting = true;
        await daemon.stop();
      },
    });
  }

  boot('startup complete');
}).catch((err: Error) => {
  // Without this the whole startup path fails silently: a rejection inside an async
  // whenReady handler is an unhandled rejection, which Electron does not surface.
  boot(`startup failed: ${err.message}\n${err.stack ?? ''}`);
  log?.write('fatal', `startup failed: ${err.message}`);
  dialog.showErrorBox('MC Hosting Node', `The node could not start:\n\n${err.message}`);
});

app.on('window-all-closed', () => {
  // Deliberately empty: the tray keeps the app alive on every platform.
});

app.on('before-quit', async (event) => {
  if (daemon && daemon.getStatus().state !== 'stopped') {
    event.preventDefault();
    quitting = true;
    await daemon.stop();
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  // Logged before the dialog: if the dialog itself cannot show (no window yet, or
  // the app was launched hidden at login), the log is the only remaining record.
  log?.write('fatal', `${err.message}\n${err.stack ?? ''}`);
  dialog.showErrorBox('MC Hosting Node', `Unexpected error:\n\n${err.message}`);
});
