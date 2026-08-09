import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getConfig } from '../config';

interface ProxyRule {
  serverId: string;
  localIp: string;
  localPort: number;
  remotePort: number;
}

class TunnelManager {
  private frpcProcess: ChildProcess | null = null;
  private frpConfigPath: string;
  private proxies: Map<string, ProxyRule> = new Map();
  private baseConfig: string = '';
  
  constructor() {
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
    const apiPort = process.env.FRP_DAEMON_API_PORT;

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
localPort = 3500
remotePort = ${apiPort}
` : ''}
    `.trim() + '\n\n';

    this.writeConfig();

    console.log('[TunnelManager] Starting frpc tunnel client...');
    this.frpcProcess = spawn('frpc', ['-c', this.frpConfigPath], {
      stdio: 'pipe',
      detached: false,
    });

    this.frpcProcess.stdout?.on('data', (data) => {
      console.log(`[frpc] ${data.toString().trim()}`);
    });

    this.frpcProcess.stderr?.on('data', (data) => {
      console.error(`[frpc error] ${data.toString().trim()}`);
    });

    this.frpcProcess.on('exit', (code) => {
      console.warn(`[TunnelManager] frpc process exited with code ${code}`);
      this.frpcProcess = null;
    });
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
