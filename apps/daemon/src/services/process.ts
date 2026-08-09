import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { CreateServerContainerDto } from '@mc-manager/shared';
import { getConfig } from '../config';
import { provisioningManager, STATUS } from './provisioning';
import { tunnelManager } from './frpc';
import { flattenServerDir } from '../utils/flatten';

export interface ManagedProcess {
  serverId: string;
  process: ChildProcess;
  status: 'STARTING' | 'RUNNING' | 'STOPPING' | 'OFFLINE';
  logBuffer: string[];
  startedAt: Date;
  onlinePlayers: Set<string>;
  statsHistory: Array<{ timestamp: string; cpuPercent: number; memoryMb: number }>;
}

export function resolveJavaCmd(mcVersion?: string): string {
  const v = mcVersion || '26.2';
  
  if (v.startsWith('26') || v.startsWith('25') || v.startsWith('1.22')) {
    if (fs.existsSync('/opt/java/openjdk-25/bin/java')) return '/opt/java/openjdk-25/bin/java';
    if (fs.existsSync('/opt/java/openjdk-21/bin/java')) return '/opt/java/openjdk-21/bin/java';
    return 'java';
  }

  const verMatch = v.match(/^1\.(\d+)/);
  if (verMatch) {
    const minor = parseInt(verMatch[1], 10);
    if (minor >= 21) {
      if (fs.existsSync('/opt/java/openjdk-21/bin/java')) return '/opt/java/openjdk-21/bin/java';
      if (fs.existsSync('/opt/java/openjdk-25/bin/java')) return '/opt/java/openjdk-25/bin/java';
      return 'java';
    }
  }

  if (fs.existsSync('/opt/java/openjdk-17/bin/java')) return '/opt/java/openjdk-17/bin/java';
  return 'java';
}

class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private startingLocks = new Set<string>();

  public getProcess(serverId: string): ManagedProcess | undefined {
    return this.processes.get(serverId);
  }

  public isRunning(serverId: string): boolean {
    const mp = this.processes.get(serverId);
    return mp !== undefined && mp.status !== 'OFFLINE';
  }

  public async ensureServerJar(serverDir: string, dto: CreateServerContainerDto): Promise<string> {
    flattenServerDir(serverDir);

    const mcVersion = dto.mcVersion || '26.2';
    const serverType = (dto.serverType || 'FABRIC').toUpperCase();
    const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
    const targetJarPath = path.join(serverDir, 'server.jar');

    // Always preserve / write metadata to ensure version is never lost on restart
    let meta: any = { mcVersion, serverType, installedVersion: mcVersion, serverPort: dto.serverPort };
    if (fs.existsSync(metaPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta = { ...existing, ...meta };
      } catch (e) {}
    }

    // 1. Check for launch scripts (modpack preferred executables)
    if (fs.existsSync(path.join(serverDir, 'run.sh'))) {
      console.log(`[ProcessManager] Using run.sh launch script`);
      return 'run.sh';
    }
    if (fs.existsSync(path.join(serverDir, 'run.bat'))) {
      console.log(`[ProcessManager] Using run.bat launch script`);
      return 'run.bat';
    }
    
    // 2. Check for custom fabric/forge launcher jars
    if (fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) {
      return 'fabric-server-launch.jar';
    }
    if (fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'))) {
      return '@user_args.txt';
    }

    // 2. Version Mismatch Purger: Deletes old server.jar if requested mcVersion changed
    const recordedVer = meta.installedVersion || meta.mcVersion;
    if (recordedVer && recordedVer !== mcVersion) {
      console.log(`[ProcessManager] Minecraft version mismatch (recorded '${recordedVer}' vs requested '${mcVersion}'). Purging old JAR, libraries, and world...`);
      fs.rmSync(targetJarPath, { force: true });
      fs.rmSync(path.join(serverDir, 'world'), { recursive: true, force: true });
      fs.rmSync(path.join(serverDir, 'libraries'), { recursive: true, force: true });
      meta.installedVersion = mcVersion;
      meta.mcVersion = mcVersion;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    // If server.jar already exists in the server folder and version matches, use it immediately
    if (fs.existsSync(targetJarPath) && !(dto as any).forceRedownload) {
      return 'server.jar';
    }

    // Check if any other jar file exists in the root (e.g., fabric-server.jar, forge.jar, etc.)
    if (!fs.existsSync(targetJarPath)) {
      const rootJars = fs.readdirSync(serverDir).filter((f: string) => 
        f.toLowerCase().endsWith('.jar') && f.toLowerCase() !== 'server.jar'
      );
      if (rootJars.length > 0) {
        console.log(`[ProcessManager] Using found jar file: ${rootJars[0]}`);
        return rootJars[0];
      }
    }

    // 3. Centralized Bundled & Persistent Cache Resolution
    const config = getConfig();
    const cacheDir = path.join(config.dataDir, 'cache', 'jars');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheFileName = `${serverType.toLowerCase()}-${mcVersion}.jar`;
    const cachedJarPath = path.join(cacheDir, cacheFileName);
    const bundledJarPath = path.join('/opt/minecraft-jars', cacheFileName);

    // Option A: Copy from persistent data cache if previously downloaded
    if (fs.existsSync(cachedJarPath)) {
      console.log(`[ProcessManager Cache Hit] Copying cached executable '${cacheFileName}' to server directory...`);
      fs.copyFileSync(cachedJarPath, targetJarPath);
      meta.installedVersion = mcVersion;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return 'server.jar';
    }

    // Option B: Copy from pre-bundled Docker image assets if available
    if (fs.existsSync(bundledJarPath)) {
      console.log(`[ProcessManager Bundled Hit] Copying pre-bundled executable '${cacheFileName}' to server directory...`);
      fs.copyFileSync(bundledJarPath, targetJarPath);
      fs.copyFileSync(bundledJarPath, cachedJarPath);
      meta.installedVersion = mcVersion;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return 'server.jar';
    }

    // Option C: Download from API once and save into central persistent cache
    console.log(`[ProcessManager Cache Miss] Pre-downloading server executable for ${serverType} (${mcVersion})...`);

    try {
      let downloadUrl = '';
      if (serverType === 'FABRIC') {
        try {
          const fRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
          if (fRes.ok) {
            const fData = await fRes.json();
            const loaderVer = fData[0]?.loader?.version || '0.19.3';
            const installerVer = fData[0]?.installer?.version || '1.0.1';
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/${installerVer}/server/jar`;
          } else {
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.19.3/1.0.1/server/jar`;
          }
        } catch (e) {
          downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.19.3/1.0.1/server/jar`;
        }
      } else if (serverType === 'PAPER') {
        const vRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}`);
        if (vRes.ok) {
          const vData = await vRes.json();
          const latestBuild = vData.builds[vData.builds.length - 1];
          downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild}/downloads/paper-${mcVersion}-${latestBuild}.jar`;
        }
      } else if (serverType === 'PURPUR') {
        downloadUrl = `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
      }

      if (!downloadUrl) {
        downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.19.3/1.0.1/server/jar`;
      }

      const res = await fetch(downloadUrl);
      if (!res.ok) {
        throw new Error(`HTTP download failed with status ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(cachedJarPath, buffer);
      fs.copyFileSync(cachedJarPath, targetJarPath);
      console.log(`[ProcessManager] Cached and installed server jar successfully (${buffer.length} bytes).`);

      meta.installedVersion = mcVersion;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      return 'server.jar';
    } catch (err: any) {
      console.warn(`[ProcessManager Warning] Automatic jar download failed: ${err.message}. Using fallback server.jar path.`);
      return 'server.jar';
    }
  }

  public async startProcess(dto: CreateServerContainerDto): Promise<void> {
    if (this.isRunning(dto.serverId) || this.startingLocks.has(dto.serverId)) {
      console.log(`[ProcessManager] Server process '${dto.serverId}' is ALREADY running or starting. Skipping duplicate spawn.`);
      return;
    }

    this.startingLocks.add(dto.serverId);

    try {

    const config = getConfig();
    const serverDir = path.join(config.dataDir, dto.serverId);

    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Ensure EULA and server.properties setup
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
    
    // dto.serverPort is always authoritative — always write it to server.properties
    // so the MC server starts on the correct port regardless of what the backup had.
    const propsPath = path.join(serverDir, 'server.properties');
    const effectivePort = dto.serverPort || 25565;

    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(
        propsPath,
        `server-ip=0.0.0.0\nserver-port=${effectivePort}\nquery.port=${effectivePort}\nenable-rcon=false\n`
      );
    } else {
      let content = fs.readFileSync(propsPath, 'utf8');
      if (content.includes('server-ip=')) {
        content = content.replace(/^server-ip=.*/m, 'server-ip=0.0.0.0');
      } else {
        content += '\nserver-ip=0.0.0.0';
      }
      // Always overwrite the port with the configured value
      if (content.match(/^server-port=\d+/m)) {
        content = content.replace(/^server-port=\d+/m, `server-port=${effectivePort}`);
      } else {
        content += `\nserver-port=${effectivePort}`;
      }
      if (content.match(/^query\.port=\d+/m)) {
        content = content.replace(/^query\.port=\d+/m, `query.port=${effectivePort}`);
      }
      fs.writeFileSync(propsPath, content);
    }

    const jarOrArgs = await this.ensureServerJar(serverDir, dto);

    // Forcefully clear any stray process holding the port on host immediately prior to spawn
    try {
      execSync(`fuser -k -9 ${effectivePort}/tcp 2>/dev/null || true`);
      execSync(`lsof -ti:${effectivePort} | xargs -r kill -9 2>/dev/null || true`);
    } catch (e) {}

    // Short pause for Linux kernel TCP socket TIME_WAIT release
    await new Promise((r) => setTimeout(r, 1000));

    let child: ChildProcess;

    // Handle launch scripts (run.sh, run.bat)
    if (jarOrArgs === 'run.sh' || jarOrArgs === 'run.bat') {
      console.log(`[ProcessManager] Spawning launch script for server ${dto.serverId} in '${serverDir}': ${jarOrArgs}`);
      // Make run.sh executable if it exists
      if (jarOrArgs === 'run.sh') {
        try {
          execSync(`chmod +x "${path.join(serverDir, 'run.sh')}"`);
        } catch (e) {}

        // Strip Windows CRLF line endings from run.sh — when uploaded from a Windows
        // system, \r\n endings cause bash to interpret each command as "command\r" which
        // isn't found, so the script exits silently with code 0 producing no output.
        const runShPath = path.join(serverDir, 'run.sh');
        try {
          const raw = fs.readFileSync(runShPath, 'utf8');
          if (raw.includes('\r')) {
            console.log(`[ProcessManager] Detected CRLF in run.sh — stripping to LF...`);
            fs.writeFileSync(runShPath, raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
          }
          // Log first few lines of run.sh for debugging
          const preview = raw.replace(/\r/g, '').split('\n').slice(0, 5).join(' | ');
          console.log(`[ProcessManager] run.sh preview: ${preview}`);
        } catch (e) {}

        // Also strip CRLF from user_jvm_args.txt and unix_args.txt if present
        for (const argFile of ['user_jvm_args.txt', 'unix_args.txt', 'user_args.txt']) {
          const argFilePath = path.join(serverDir, argFile);
          if (fs.existsSync(argFilePath)) {
            try {
              const raw = fs.readFileSync(argFilePath, 'utf8');
              if (raw.includes('\r')) {
                fs.writeFileSync(argFilePath, raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
                console.log(`[ProcessManager] Stripped CRLF from ${argFile}`);
              }
            } catch (e) {}
          }
        }
      }

      // Resolve the correct Java binary for this server's MC version and inject it into PATH.
      // Modpack run.sh scripts call `java` directly and will silently fail (exit 0) if
      // the binary isn't discoverable on PATH.
      const metaPathForScript = path.join(serverDir, 'craftcontrol-meta.json');
      let scriptMcVersion = dto.mcVersion || '1.20.1';
      if (fs.existsSync(metaPathForScript)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPathForScript, 'utf8'));
          scriptMcVersion = meta.installedVersion || meta.mcVersion || scriptMcVersion;
        } catch (e) {}
      }
      const resolvedJavaCmd = resolveJavaCmd(scriptMcVersion);
      const javaDir = path.dirname(resolvedJavaCmd);
      const javaHome = path.dirname(javaDir); // e.g. /opt/java/openjdk-21
      const augmentedPath = `${javaDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
      console.log(`[ProcessManager] Injecting JAVA_HOME=${javaHome} and java dir ${javaDir} into PATH for run.sh`);

      // Strip the trailing empty arg — bash interprets argv[0] as script name when called as `bash <script>`
      const scriptArgs = jarOrArgs === 'run.sh' ? ['run.sh'] : ['/c', 'run.bat'];
      child = spawn(jarOrArgs === 'run.sh' ? '/bin/bash' : 'cmd.exe',
        scriptArgs,
        {
          cwd: serverDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: augmentedPath,
            JAVA_HOME: javaHome,
          },
        }
      );
    } else {
      // Handle Java jar files
      const memoryMb = dto.memoryMb || 4096;
      let javaArgs: string[] = [
        `-Xmx${memoryMb}M`,
        `-Xms1024M`,
        `-Dfile.encoding=UTF-8`,
        `-Djava.awt.headless=true`,
        `-Djava.net.preferIPv4Stack=true`,
      ];

      if (jarOrArgs === '@user_args.txt') {
        javaArgs.push('@user_args.txt', 'nogui');
      } else {
        javaArgs.push('-jar', jarOrArgs, 'nogui');
      }

      const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
      let effectiveMcVersion = dto.mcVersion || '26.2';
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          effectiveMcVersion = meta.installedVersion || meta.mcVersion || effectiveMcVersion;
        } catch (e) {}
      }

      const javaCmd = resolveJavaCmd(effectiveMcVersion);
      console.log(`[ProcessManager] Spawning standalone Java process using '${javaCmd}' for server ${dto.serverId} in '${serverDir}': ${javaCmd} ${javaArgs.join(' ')}`);

      child = spawn(javaCmd, javaArgs, {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
        },
      });
    }

    const mp: ManagedProcess = {
      serverId: dto.serverId,
      process: child,
      status: 'STARTING',
      logBuffer: [],
      startedAt: new Date(),
      onlinePlayers: new Set<string>(),
      statsHistory: [],
    };

    this.processes.set(dto.serverId, mp);

    // NOTE: Process-mode servers run directly on --network host and are already
    // reachable without tunneling. Registering an FRP tunnel would cause frps to
    // bind to the same port as the MC server, creating an "address already in use"
    // conflict. FRP tunnels are only used for Docker-container-mode servers.
    // (No tunnel registration here)

    const handleData = (data: Buffer) => {
      const text = data.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        
        mp.logBuffer.push(line);
        if (mp.logBuffer.length > 300) mp.logBuffer.shift();

        this.emit('log', { serverId: dto.serverId, line, type: 'stdout' });

        // Player Join Detection
        const joinMatch = line.match(/(?:\[.*\]:?\s*)?([a-zA-Z0-9_]{2,16}) (?:joined the game|logged in with entity id)/i);
        if (joinMatch) {
          const username = joinMatch[1];
          mp.onlinePlayers.add(username);
          console.log(`[PlayerManager] Player joined on server ${dto.serverId}: ${username}`);
        }

        // Player Leave Detection
        const leaveMatch = line.match(/(?:\[.*\]:?\s*)?([a-zA-Z0-9_]{2,16}) (?:left the game|lost connection)/i);
        if (leaveMatch) {
          const username = leaveMatch[1];
          mp.onlinePlayers.delete(username);
          console.log(`[PlayerManager] Player left server ${dto.serverId}: ${username}`);
        }

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

    if (child.stdout) child.stdout.on('data', handleData);
    if (child.stderr) child.stderr.on('data', handleData);

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
    } finally {
      this.startingLocks.delete(dto.serverId);
    }
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

  public getOnlinePlayers(serverId: string): Array<{ username: string; isOp: boolean; avatarUrl: string }> {
    const mp = this.processes.get(serverId);
    if (!mp) return [];

    const serverDir = path.join(getConfig().dataDir, serverId);
    const opsPath = path.join(serverDir, 'ops.json');
    const opsSet = new Set<string>();

    if (fs.existsSync(opsPath)) {
      try {
        const opsData = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
        if (Array.isArray(opsData)) {
          opsData.forEach((op: any) => {
            if (op.name) opsSet.add(op.name.toLowerCase());
          });
        }
      } catch (e) {}
    }

    return Array.from(mp.onlinePlayers).map((username) => ({
      username,
      isOp: opsSet.has(username.toLowerCase()),
      avatarUrl: `https://mc-heads.net/avatar/${username}/64`,
    }));
  }

  public getProcessStats(serverId: string): { cpuPercent: number; memoryMb: number; history: Array<{ timestamp: string; cpuPercent: number; memoryMb: number }> } {
    const mp = this.processes.get(serverId);
    if (!mp) {
      return { cpuPercent: 0, memoryMb: 0, history: [] };
    }

    // Attempt RSS memory and CPU sampling
    let cpuPercent = 0;
    let memoryMb = 0;

    if (mp.process && mp.process.pid) {
      try {
        const statStr = execSync(`ps -p ${mp.process.pid} -o %cpu,rss --no-headers 2>/dev/null || true`).toString().trim();
        if (statStr) {
          const parts = statStr.split(/\s+/);
          if (parts.length >= 2) {
            cpuPercent = parseFloat(parts[0]) || 0;
            memoryMb = Math.round((parseInt(parts[1], 10) || 0) / 1024);
          }
        }
      } catch (e) {}
    }

    const currentPoint = {
      timestamp: new Date().toLocaleTimeString(),
      cpuPercent,
      memoryMb,
    };

    mp.statsHistory.push(currentPoint);
    if (mp.statsHistory.length > 20) mp.statsHistory.shift();

    return {
      cpuPercent,
      memoryMb,
      history: mp.statsHistory,
    };
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
