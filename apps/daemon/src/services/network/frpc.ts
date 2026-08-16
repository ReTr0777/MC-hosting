import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getConfig } from '../../config';

interface ProxyRule {
  serverId: string;
  localIp: string;
  localPort: number;
  remotePort: number;
}

/**
 * The frpc executable to run.
 *
 * The Docker image installs it on PATH (see apps/daemon/Dockerfile). The desktop node
 * app ships its own copy and points FRPC_PATH at it, because a Windows machine has no
 * PATH entry for frpc and asking every node hoster to install one by hand defeats the
 * point of an installer.
 */
function frpcBinary(): string {
  return process.env.FRPC_PATH || 'frpc';
}

class TunnelManager {
  private frpcProcess: ChildProcess | null = null;
  /** Set once frpc turns out to be unusable, so the warning is not repeated on every reload. */
  private spawnFailed = false;
  private frpConfigPath: string;
  private proxies: Map<string, ProxyRule> = new Map();
  private baseConfig: string = '';
  
  constructor() {
    this.registerCleanup();
    const dataDir = getConfig().dataDir;
    // frpc.toml lives one level above the servers subdir (e.g. /app/data/frpc.toml)
    const baseDataDir = path.dirname(dataDir);
    this.frpConfigPath = path.join(baseDataDir, 'frpc.toml');
  }

  public async init() {
    // If a process is already running, kill it before restarting
    if (this.frpcProcess) {
      console.log('[TunnelManager] Killing existing frpc process...');
      this.frpcProcess.kill('SIGTERM');
      this.frpcProcess = null;
      // Wait for frps to clean up the old proxy registration before reconnecting
      await new Promise((r) => setTimeout(r, 1500));
    }

    const config = getConfig();
    const serverAddr = config.frpServerAddr;
    const serverPort = config.frpServerPort || 7000;
    const token = config.frpToken;
    const apiPort = config.frpApiRemotePort;

    if (!serverAddr) {
      console.log('[TunnelManager] FRP Server Address not configured. Tunneling disabled.');
      return;
    }

    this.baseConfig = `
serverAddr = "${serverAddr}"
serverPort = ${serverPort}
${token ? `\n[auth]\nmethod = "token"\ntoken = "${token}"` : ''}

${apiPort ? `
[[proxies]]
name = "daemon-api-${apiPort}"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${config.port}
remotePort = ${apiPort}
` : ''}
    `.trim() + '\n\n';

    this.writeConfig();

    if (apiPort) {
      console.log(
        `[TunnelManager] Publishing this node's API at ${serverAddr}:${apiPort}. ` +
          'Register the node in the panel at that address, not at this machine\'s own IP.'
      );
    }

    const binary = frpcBinary();
    console.log('[TunnelManager] Starting frpc tunnel client...');

    /*
     * spawn reports a failure in one of two ways, and it has to be caught both times.
     * A binary that is missing arrives asynchronously as an 'error' event; one that
     * Windows refuses to execute — EPERM, typically antivirus — throws synchronously,
     * straight out of this async function and into an unhandled rejection that kills
     * the node. Same failure, same response, two code paths.
     */
    try {
      this.frpcProcess = spawn(binary, ['-c', this.frpConfigPath], {
        stdio: 'pipe',
        detached: false,
      });
    } catch (err) {
      this.reportSpawnFailure(err as NodeJS.ErrnoException, binary);
      return;
    }

    /*
     * Record the pid so the next run can clean up after this one.
     *
     * frpc outlives a daemon that is killed rather than asked to stop — which is every
     * crash, and on Windows every stop, since signals are not delivered there. The
     * supervising app reads this file on start and kills what it names. Its absence is
     * the normal case and costs nothing to check, which matters: the alternative was
     * hunting for stray processes on every single start.
     */
    this.writePidFile(this.frpcProcess.pid);

    // Without this handler a failed spawn emits an unhandled 'error' event, which takes
    // down the whole daemon: a node with a tunnel address typed into it would die on
    // startup and stay dead.
    this.frpcProcess.on('error', (err: NodeJS.ErrnoException) => this.reportSpawnFailure(err, binary));

    this.frpcProcess.stdout?.on('data', (data) => {
      console.log(`[frpc] ${data.toString().trim()}`);
    });

    this.frpcProcess.stderr?.on('data', (data) => {
      console.error(`[frpc error] ${data.toString().trim()}`);
    });

    this.frpcProcess.on('exit', (code) => {
      console.warn(`[TunnelManager] frpc process exited with code ${code}`);
      this.frpcProcess = null;
      // It exited on its own, so it is not stranded and must not be hunted later.
      this.clearPidFile();
    });
  }

  /**
   * Takes frpc down with the daemon.
   *
   * frpc is a child process, not a subprocess of the OS's imagination: when the daemon
   * goes away it keeps running, keeps its control connection to the tunnel server, and
   * keeps its proxy registered. The next daemon start then registers the same remote
   * port against a server that still believes the dead one owns it, so the tunnel
   * server accepts connections and forwards them nowhere — a node that answers for a
   * moment and then hangs forever, which is far harder to diagnose than one that is
   * plainly down.
   *
   * Signals are not delivered on Windows, where a killed parent leaves frpc orphaned
   * regardless; the desktop app kills the process tree for that case.
   */
  /** Written beside frpc.toml; see the call site for why it exists. */
  private get pidFilePath(): string {
    return path.join(path.dirname(this.frpConfigPath), 'frpc.pid');
  }

  private writePidFile(pid: number | undefined): void {
    if (!pid) return;
    try {
      fs.writeFileSync(this.pidFilePath, String(pid), 'utf8');
    } catch {
      // Cleanup is a courtesy to the next run, never a reason to fail this one.
    }
  }

  private clearPidFile(): void {
    try {
      fs.rmSync(this.pidFilePath, { force: true });
    } catch {
      /* as above */
    }
  }

  private registerCleanup(): void {
    const stop = () => {
      if (!this.frpcProcess) return;
      this.frpcProcess.kill();
      this.frpcProcess = null;
      // Killed by us, so there is nothing left for the next run to clean up.
      this.clearPidFile();
    };

    // 'exit' handlers must be synchronous, which kill() is.
    process.on('exit', stop);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        stop();
        // Re-raising would need the default handler back; exiting here is equivalent
        // and keeps the code obvious.
        process.exit(0);
      });
    }
  }

  /**
   * Reports frpc failing to launch, once, and carries on.
   *
   * The tunnel is an optional extra. Whatever went wrong with it, the node itself must
   * stay up: it still hosts servers, and the panel still needs to reach it.
   */
  private reportSpawnFailure(err: NodeJS.ErrnoException, binary: string): void {
    this.frpcProcess = null;
    // init() runs again on every tunnel change, and repeating the whole explanation
    // each time buries the log the operator is trying to read.
    if (this.spawnFailed) return;
    this.spawnFailed = true;

    const tail =
      'Tunnelling is off and the node keeps running, but players cannot reach servers on ' +
      'this machine through the tunnel. Clear the tunnel server address to stop trying.';

    /*
     * Antivirus is the common thread in all three of these, because frp is a legitimate
     * tunnel that intruders also use, so scanners routinely flag it as a hacktool. The
     * codes differ by how far the scanner got: removed the file, blocked execution, or
     * still has it locked mid-scan. Saying so is the difference between a fix that
     * takes a minute and an evening of guessing.
     */
    const bundled = Boolean(process.env.FRPC_PATH);
    if (err.code === 'ENOENT') {
      console.error(
        bundled
          ? `[TunnelManager] frpc is missing from "${binary}". Antivirus quarantining it is the usual ` +
              `cause — restore it and add an exclusion, or reinstall the node app. ${tail}`
          : `[TunnelManager] frpc was not found (tried "${binary}"). ${tail} Or set FRPC_PATH to an frpc binary.`
      );
    } else if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
      const why =
        err.code === 'EBUSY'
          ? 'The file is locked by another program — antivirus scanning or quarantining it is the usual cause'
          : 'Antivirus blocking or quarantining it is the usual cause';
      console.error(
        `[TunnelManager] Windows refused to run frpc (${err.code}) at "${binary}". ${why} — allow that ` +
          `file, then restart the node. ${tail}`
      );
    } else {
      console.error(`[TunnelManager] frpc failed to start: ${err.message}. ${tail}`);
    }
  }

  private writeConfig() {
    let config = this.baseConfig;
    for (const rule of this.proxies.values()) {
      config += `
[[proxies]]
name = "mc-server-${rule.serverId}"
type = "tcp"
localIP = "${rule.localIp}"
localPort = ${rule.localPort}
remotePort = ${rule.remotePort}
      `.trim() + '\n\n';
    }
    fs.writeFileSync(this.frpConfigPath, config, 'utf8');
  }

  public async addTunnel(serverId: string, localIp: string, localPort: number, remotePort: number) {
    this.proxies.set(serverId, { serverId, localIp, localPort, remotePort });
    this.writeConfig();
    await this.reload();
  }

  public async removeTunnel(serverId: string) {
    if (this.proxies.has(serverId)) {
      this.proxies.delete(serverId);
      this.writeConfig();
      await this.reload();
    }
  }

  private async reload() {
    console.log('[TunnelManager] Reloading frpc configuration by restarting tunnel process...');
    await this.init();
  }
}

export const tunnelManager = new TunnelManager();
