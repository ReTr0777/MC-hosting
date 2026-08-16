import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared-types';

/*
 * Updates on the node hoster's terms: the node checks on launch and every few hours,
 * but nothing is downloaded or installed until they say so.
 *
 * Installing restarts the agent, which makes the node blink offline in the panel for
 * a few seconds. The game servers themselves are unaffected — they are Docker
 * containers with their own restart policies and do not belong to this process — but
 * a node hoster with players connected is the one who should pick the moment, so the
 * decision is theirs rather than a background task's.
 *
 * A declined update is not forgotten: it stays pending, the window offers it, and the
 * next launch asks again. It is simply never taken behind their back.
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
  /**
   * Asks the node hoster whether to take this version now. Resolving false defers it
   * — the update stays available, but this run will not ask about it again.
   */
  confirmUpdate: (version: string) => Promise<boolean>;
}

export interface UpdaterControls {
  /** Check now, on top of the periodic checks. */
  check: () => void;
  /**
   * Take the pending update: what the window's "Install update" button calls, and the
   * way back for anyone who said "later" earlier. No-op when nothing is pending.
   */
  installPending: () => void;
}

export function initAutoUpdates({ log, onStatus, beforeInstall, confirmUpdate }: UpdaterHooks): UpdaterControls {
  // Both off: downloading and installing are what the node hoster is consenting to.
  // autoInstallOnAppQuit especially — leaving it on would apply a declined update the
  // next time they closed the app, which is exactly the surprise this avoids.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater warn: ${String(m)}`),
    error: (m: unknown) => log(`updater error: ${String(m)}`),
    debug: () => {},
  };

  /** The version found and not yet installed, if any. */
  let pending: string | null = null;
  /** Set once they accept, so the finished download knows to go ahead and install. */
  let accepted = false;
  /** Versions already declined this run — checks keep firing, the prompt should not. */
  const declined = new Set<string>();
  /** Guards the prompt and the download against a periodic check arriving mid-flight. */
  let busy = false;

  const startDownload = (version: string) => {
    accepted = true;
    onStatus({ state: 'downloading', version, percent: 0 });
    autoUpdater.downloadUpdate().catch((err: Error) => {
      accepted = false;
      log(`download failed: ${err.message}`);
      onStatus({ state: 'error', version, percent: null });
    });
  };

  autoUpdater.on('checking-for-update', () => {
    // Leave a pending update showing rather than flicking the badge back to "checking"
    // and losing the version the user is being offered.
    if (!pending) onStatus({ state: 'checking', version: null, percent: null });
  });

  autoUpdater.on('update-not-available', () => {
    pending = null;
    onStatus({ state: 'current', version: null, percent: null });
  });

  autoUpdater.on('update-available', async (info) => {
    pending = info.version;
    if (busy || accepted) return;
    log(`update available: ${info.version}`);
    onStatus({ state: 'available', version: info.version, percent: null });

    if (declined.has(info.version)) return;

    busy = true;
    try {
      if (await confirmUpdate(info.version)) startDownload(info.version);
      else {
        declined.add(info.version);
        log(`update ${info.version} deferred by the node hoster`);
      }
    } finally {
      busy = false;
    }
  });

  autoUpdater.on('download-progress', (p) => {
    onStatus({ state: 'downloading', version: pending, percent: Math.round(p.percent) });
  });

  autoUpdater.on('error', (err) => {
    // A failed check must never stop the node from running; it just means this
    // machine stays on its current version until the next attempt.
    log(`update check failed: ${err.message}`);
    onStatus({ state: 'error', version: null, percent: null });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    // Only ever reached after a download this code started, i.e. after consent.
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

  return {
    check,
    installPending: () => {
      if (!pending || accepted || busy) return;
      declined.delete(pending);
      startDownload(pending);
    },
  };
}
