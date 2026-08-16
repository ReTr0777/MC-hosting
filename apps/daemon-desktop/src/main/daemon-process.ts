import { fork, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import type { DaemonStatus, DaemonState, LogLine } from '../shared-types';

const MAX_LOG_LINES = 2000;

/**
 * Supervises the daemon as a child process.
 *
 * It runs out-of-process deliberately: a crash in the agent then leaves the window
 * up to show why, and the user can restart it without relaunching the app. Forking
 * with ELECTRON_RUN_AS_NODE reuses Electron's bundled Node, so the installer ships
 * one runtime instead of two.
 */
export class DaemonProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: DaemonState = 'stopped';
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private logs: LogLine[] = [];
  /** Set while a user-requested stop is in flight, so the exit isn't reported as a crash. */
  private stopping = false;
  /** Raised by the stderr watcher so the exit handler can explain *why* it died. */
  private portConflict = false;
  /** Likewise: the agent's own files are incomplete, so no restart will help. */
  private brokenInstall = false;

  constructor(
    private readonly entryPath: string,
    private readonly serversDir: string,
    /**
     * Working directory for the child. Never derive it from entryPath: packaged, the
     * agent lives inside app.asar, and spawning with a cwd inside the archive fails —
     * the OS needs a real directory. The daemon only falls back to cwd for its data
     * path when DAEMON_DATA_DIR is unset, which it never is here.
     */
    private readonly workingDir: string,
    /**
     * Extra module search path for the child, or null to leave resolution alone.
     * Packaged, the agent is a single bundled file and the handful of packages that
     * could not be bundled live in a vendor/ directory it would never find on its
     * own — electron-builder strips anything called node_modules.
     */
    private readonly modulePath: string | null,
    /**
     * The frpc binary to hand the agent, or null to let it search PATH. Packaged, the
     * app ships its own copy — a Windows machine has no frpc on PATH, and the tunnel
     * would silently never come up.
     */
    private readonly frpcPath: string | null,
    private readonly getPort: () => number,
    /** Mirrors everything to the on-disk log; the in-memory buffer dies with the app. */
    private readonly toFile: (message: string) => void = () => {}
  ) {
    super();
  }

  getStatus(): DaemonStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.getPort(),
      lastError: this.lastError,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  getLogs(): LogLine[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
    this.emit('logs-cleared');
  }

  private log(stream: LogLine['stream'], text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry: LogLine = { ts: Date.now(), stream, text: line };
      this.logs.push(entry);
      this.emit('log', entry);
      this.toFile(`${stream}: ${line}`);
    }
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
  }

  private setState(state: DaemonState): void {
    this.state = state;
    this.emit('status', this.getStatus());
  }

  start(): void {
    if (this.child) return;

    if (!fs.existsSync(this.entryPath)) {
      this.lastError = `Daemon build not found at ${this.entryPath}. Run "npm run build" in apps/daemon-desktop.`;
      this.log('app', this.lastError);
      this.setState('crashed');
      return;
    }

    this.lastError = null;
    this.stopping = false;
    this.setState('starting');
    this.log('app', 'Starting daemon agent...');

    this.child = fork(this.entryPath, [], {
      // Electron's binary doubles as a Node runtime when this is set.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAEMON_DATA_DIR: this.serversDir,
        DAEMON_PORT: String(this.getPort()),
        ...(this.modulePath ? { NODE_PATH: this.modulePath } : {}),
        ...(this.frpcPath ? { FRPC_PATH: this.frpcPath } : {}),
      },
      cwd: this.workingDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    this.startedAt = Date.now();
    this.child.stdout?.on('data', (b: Buffer) => this.log('out', b.toString()));
    this.child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      // A port clash is the most likely first-run failure — another node agent, or a
      // Docker-hosted daemon already on 3500. Say so plainly instead of leaving the
      // user to read a Node stack trace out of the log pane.
      if (text.includes('EADDRINUSE')) {
        this.portConflict = true;
      }
      // The agent shipped without part of itself. Historically this was an update
      // dropping the dependency tree; whatever the cause, restarting cannot fix it
      // and the raw MODULE_NOT_FOUND stack tells the user nothing they can act on.
      if (text.includes('MODULE_NOT_FOUND') || text.includes('Cannot find module')) {
        this.brokenInstall = true;
      }
      this.log('err', text);
    });

    this.child.on('error', (err) => {
      this.lastError = err.message;
      this.log('app', `Failed to start: ${err.message}`);
    });

    this.child.on('exit', (code, signal) => {
      const clean = this.stopping || code === 0;
      this.child = null;
      this.startedAt = null;
      if (clean) {
        this.log('app', 'Daemon agent stopped.');
        this.setState('stopped');
      } else if (this.brokenInstall) {
        this.lastError =
          'This node agent is missing part of its own installation, so it cannot start. ' +
          'Reinstalling MC Hosting Node from the latest installer will repair it.';
        this.log('app', this.lastError);
        this.setState('crashed');
      } else if (this.portConflict) {
        this.lastError =
          `Port ${this.getPort()} is already in use. Another node agent — or a daemon running in ` +
          `Docker — already has it. Change the port on the Connection tab, or stop the other one.`;
        this.log('app', this.lastError);
        this.setState('crashed');
      } else {
        this.lastError = `Daemon exited unexpectedly (${signal ?? `code ${code}`}).`;
        this.log('app', this.lastError);
        this.setState('crashed');
      }
      this.stopping = false;
      this.portConflict = false;
      this.brokenInstall = false;
    });

    // The agent binds its port a moment after fork; there is no ready handshake to
    // wait on, so treat a process that is still alive shortly after spawn as up.
    setTimeout(() => {
      if (this.child && this.state === 'starting') this.setState('running');
    }, 1200);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child) return resolve();
      this.stopping = true;
      this.log('app', 'Stopping daemon agent...');
      const child = this.child;
      const timer = setTimeout(() => {
        // Containers keep running regardless; this only kills the agent.
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }
}
