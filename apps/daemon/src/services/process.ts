import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { CreateServerContainerDto } from '@mc-manager/shared';
import { getConfig } from '../config';
import { provisioningManager, STATUS } from './provisioning';
import { tunnelManager } from './frpc';

export interface ManagedProcess {
  serverId: string;
  process: ChildProcess;
  status: 'STARTING' | 'RUNNING' | 'STOPPING' | 'OFFLINE';
  logBuffer: string[];
  startedAt: Date;
}

class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();

  public getProcess(serverId: string): ManagedProcess | undefined {
    return this.processes.get(serverId);
  }

  public isRunning(serverId: string): boolean {
    const mp = this.processes.get(serverId);
    return mp !== undefined && mp.status !== 'OFFLINE';
  }

  public async ensureServerJar(serverDir: string, dto: CreateServerContainerDto): Promise<string> {
    const mcVersion = dto.mcVersion || '1.20.1';

    // 1. Check for existing jar / launcher scripts
    if (fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) {
      return 'fabric-server-launch.jar';
    }
    if (fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'))) {
      return '@user_args.txt';
    }
    if (fs.existsSync(path.join(serverDir, 'server.jar'))) {
      return 'server.jar';
    }
    if (fs.existsSync(path.join(serverDir, 'paper.jar'))) {
      return 'paper.jar';
    }
    if (fs.existsSync(path.join(serverDir, 'purpur.jar'))) {
      return 'purpur.jar';
    }

    // 2. Download appropriate jar based on serverType if not present
    const targetJarPath = path.join(serverDir, 'server.jar');
    console.log(`[ProcessManager] Downloading server executable for ${dto.serverType} (${mcVersion}) into ${serverDir}...`);

    try {
      let downloadUrl = '';
      if (dto.serverType === 'FABRIC') {
        downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.16.0/1.0.1/server/jar`;
      } else if (dto.serverType === 'PAPER') {
        const vRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}`);
        if (vRes.ok) {
          const vData = await vRes.json();
          const latestBuild = vData.builds[vData.builds.length - 1];
          downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild}/downloads/paper-${mcVersion}-${latestBuild}.jar`;
        }
      } else if (dto.serverType === 'PURPUR') {
        downloadUrl = `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
      }

      if (!downloadUrl) {
        // Fallback to Fabric loader jar or Fabric installer
        downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.16.0/1.0.1/server/jar`;
      }

      const res = await fetch(downloadUrl);
      if (!res.ok) {
        throw new Error(`HTTP download failed with status ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(targetJarPath, buffer);
      console.log(`[ProcessManager] Downloaded server jar successfully (${buffer.length} bytes).`);
      return 'server.jar';
    } catch (err: any) {
      console.warn(`[ProcessManager Warning] Automatic jar download failed: ${err.message}. Using fallback server.jar path.`);
      return 'server.jar';
    }
  }

  public async startProcess(dto: CreateServerContainerDto): Promise<void> {
    const config = getConfig();
    const serverDir = path.join(config.dataDir, dto.serverId);

    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Ensure EULA and server.properties setup
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
    
    // Ensure server.properties sets configured serverPort
    const propsPath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(
        propsPath,
        `server-port=${dto.serverPort}\nquery.port=${dto.serverPort}\nenable-rcon=false\n`
      );
    } else {
      let content = fs.readFileSync(propsPath, 'utf8');
      content = content.replace(/^server-port=\d+/m, `server-port=${dto.serverPort}`);
      fs.writeFileSync(propsPath, content);
    }

    const jarOrArgs = await this.ensureServerJar(serverDir, dto);

    const memoryMb = dto.memoryMb || 2048;
    let javaArgs: string[] = [`-Xmx${memoryMb}M`, `-Xms512M`];

    if (jarOrArgs === '@user_args.txt') {
      javaArgs.push('@user_args.txt', 'nogui');
    } else {
      javaArgs.push('-jar', jarOrArgs, 'nogui');
    }

    console.log(`[ProcessManager] Spawning standalone Java process for server ${dto.serverId} in '${serverDir}': java ${javaArgs.join(' ')}`);

    const child = spawn('java', javaArgs, {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        JAVA_OPTS: `-Djava.awt.headless=true`,
      },
    });

    const mp: ManagedProcess = {
      serverId: dto.serverId,
      process: child,
      status: 'STARTING',
      logBuffer: [],
      startedAt: new Date(),
    };

    this.processes.set(dto.serverId, mp);

    // Register FRP Tunnel if applicable
    try {
      const targetLocalIp = process.env.HOST_IP || '127.0.0.1';
      console.log(`[ProcessManager Tunnel] Registering tunnel for standalone server ${dto.serverId}: ${targetLocalIp}:${dto.serverPort} -> remote:${dto.serverPort}`);
      await tunnelManager.addTunnel(dto.serverId, targetLocalIp, dto.serverPort, dto.serverPort);
    } catch (e: any) {
      console.warn(`[ProcessManager Tunnel Warning] ${e.message}`);
    }

    const handleData = (data: Buffer) => {
      const text = data.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        
        mp.logBuffer.push(line);
        if (mp.logBuffer.length > 300) mp.logBuffer.shift();

        this.emit('log', { serverId: dto.serverId, line, type: 'stdout' });
        provisioningManager.emitLog(dto.serverId, 'process', line);

        if (line.includes('Done (') && line.includes(')! For help, type "help"')) {
          mp.status = 'RUNNING';
          provisioningManager.emit('status', {
            serverId: dto.serverId,
            status: STATUS.RUNNING,
            reason: 'Standalone process booted cleanly',
          });
        }
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('error', (err) => {
      console.error(`[ProcessManager Fatal] Child process error on server ${dto.serverId}:`, err.message);
      mp.status = 'OFFLINE';
      this.processes.delete(dto.serverId);
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.FAILED,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      console.log(`[ProcessManager] Standalone process for server ${dto.serverId} exited with code ${code}`);
      mp.status = 'OFFLINE';
      this.processes.delete(dto.serverId);
      tunnelManager.removeTunnel(dto.serverId).catch(() => {});
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.OFFLINE,
        reason: `Process exited with code ${code}`,
      });
    });
  }

  public writeStdin(serverId: string, command: string): boolean {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process || mp.process.killed) return false;

    try {
      mp.process.stdin?.write(`${command}\n`);
      return true;
    } catch (e: any) {
      console.warn(`[ProcessManager Write Error] ${e.message}`);
      return false;
    }
  }

  public async stopProcess(serverId: string): Promise<void> {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process) return;

    mp.status = 'STOPPING';
    console.log(`[ProcessManager] Stopping standalone process for server ${serverId}...`);

    this.writeStdin(serverId, 'stop');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.processes.has(serverId)) {
          console.warn(`[ProcessManager] Force killing unresponsive server process ${serverId}...`);
          try { mp.process.kill('SIGKILL'); } catch (e) {}
          this.processes.delete(serverId);
        }
        resolve();
      }, 15000);

      mp.process.on('close', () => {
        clearTimeout(timeout);
        this.processes.delete(serverId);
        resolve();
      });
    });
  }

  public async killProcess(serverId: string): Promise<void> {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process) return;

    console.log(`[ProcessManager] Force killing standalone process ${serverId}...`);
    try { mp.process.kill('SIGKILL'); } catch (e) {}
    this.processes.delete(serverId);
    await tunnelManager.removeTunnel(serverId).catch(() => {});
  }
}

export const processManager = new ProcessManager();
