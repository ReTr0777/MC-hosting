import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared-types';

/*
 * Fully automatic updates: the node checks on launch and every few hours, downloads
 * in the background, and installs without asking.
 *
 * Installing restarts the agent, which makes the node blink offline in the panel for
 * a few seconds. The game servers themselves are unaffected — they are Docker
 * containers with their own restart policies and do not belong to this process.
 *
 * Nothing here runs unpackaged: without an installer and a latest.yml to compare
 * against, electron-updater only produces noise in development.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdaterHooks {
  log: (message: string) => void;
  onStatus: (status: UpdateStatus) => void;
  /** Stops the daemon cleanly before the installer replaces the files underneath it. */
  beforeInstall: () => Promise<void>;
}

export function initAutoUpdates({ log, onStatus, beforeInstall }: UpdaterHooks): void {
  autoUpdater.autoDownload = true;
  // Belt and braces: if a download finishes but the immediate install below is
  // interrupted, the update still applies the next time the app exits.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater warn: ${String(m)}`),
    error: (m: unknown) => log(`updater error: ${String(m)}`),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => onStatus({ state: 'checking', version: null, percent: null }));

  autoUpdater.on('update-not-available', () => onStatus({ state: 'current', version: null, percent: null }));

  autoUpdater.on('update-available', (info) => {
    log(`update available: ${info.version}`);
    onStatus({ state: 'downloading', version: info.version, percent: 0 });
  });

  autoUpdater.on('download-progress', (p) => {
    onStatus({ state: 'downloading', version: null, percent: Math.round(p.percent) });
  });

  autoUpdater.on('error', (err) => {
    // A failed check must never stop the node from running; it just means this
    // machine stays on its current version until the next attempt.
    log(`update check failed: ${err.message}`);
    onStatus({ state: 'error', version: null, percent: null });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update ${info.version} downloaded; restarting to install`);
    onStatus({ state: 'installing', version: info.version, percent: 100 });
    try {
      await beforeInstall();
    } catch {
      // Even if the agent will not shut down cleanly, the update should still land.
    }
    // isSilent: skip the installer UI. isForceRunAfter: bring the node back up
    // afterwards, which matters because the window may never have been opened.
    autoUpdater.quitAndInstall(true, true);
  });

  const check = () => {
    // Swallowed, not logged: a failed check both rejects this promise and emits the
    // 'error' event above, so logging here as well duplicates every line.
    autoUpdater.checkForUpdates().catch(() => {});
  };

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
