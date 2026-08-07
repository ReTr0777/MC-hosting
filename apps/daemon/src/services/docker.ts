import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';
import { CreateServerContainerDto } from '@mc-manager/shared';
import { getConfig } from '../config';
import { sanitizeMrpack } from './modrinth';
import { buildServerWithServerPackCreator } from './serverpackcreator';
import { installCurseForgeModpack } from './curseforge';
import { provisioningManager, STATUS } from './provisioning';
import { tunnelManager } from './frpc';

const docker = new Docker();
const CLIENT_ONLY_DENYLIST = [
  'missingmodschecker',
  'missing-mods-checker',
  'modmenu',
  'mod-menu',
  'crashexploitfixer',
  'crash-exploit-fixer',
  'entityculling',
  'item-group-extra',
  'inventorytabs',
  'inventory-tabs',
  'discord-rpc',
  'presence',
  'craftpresence',
  'catalogue',
  'configured',
  'client-sort',
  'smooth-swapping',
  'controlify',
  '3dskinlayers',
  'forgeconfigscreens',
  'krypton',
  'forge-config-screens',
  'bettercompatibilitychecker',
  'better-compatibility-checker',
  'bcc',
  'serverbrowser',
  'server-browser',
  'soundphysics',
  'sound_physics',
  'zoomify',
  'freecam',
  'iris',
  'sodium',
  'oculus',
  'rubidium',
];

export function getItzgImageTag(mcVersion?: string): string {
  if (!mcVersion || mcVersion === 'LATEST') return 'itzg/minecraft-server:latest';
  
  const parts = mcVersion.split('.');
  const major = parseInt(parts[0] || '0', 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);

  if (major >= 26) {
    return 'itzg/minecraft-server:java25';
  }

  if (major === 1) {
    if (minor >= 26) {
      return 'itzg/minecraft-server:java25';
    }
    if (minor >= 21 || (minor === 20 && patch >= 5)) {
      return 'itzg/minecraft-server:java21';
    }
    if (minor >= 17) {
      return 'itzg/minecraft-server:java17';
    }
  }

  return 'itzg/minecraft-server:java8';
}

export async function ensureDockerImage(imageName: string): Promise<void> {
  try {
    const images = await docker.listImages({
      filters: { reference: [imageName] },
    });

    if (images.length === 0) {
      console.log(`[Docker] Image ${imageName} not found locally. Auto-pulling...`);
      await new Promise((resolve, reject) => {
        docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (progressErr: Error | null) => {
            if (progressErr) return reject(progressErr);
            resolve(true);
          });
        });
      });
      console.log(`[Docker] Pull complete for ${imageName}.`);
    }
  } catch (err) {
    console.error(`[Docker] Failed to pull image ${imageName}:`, err);
    throw err;
  }
}

export function scrubIncompatibleConfigs(serverDir: string, serverId: string): void {
  const configsToScrub = [
    path.join(serverDir, 'defaultconfigs', 'comforts-server.toml'),
    path.join(serverDir, 'config', 'comforts-server.toml'),
  ];

  for (const filePath of configsToScrub) {
    if (fs.existsSync(filePath)) {
      console.warn(`[Config Scrubber] Deleting SpectreLib bug-triggering config: ${filePath}`);
      try {
        fs.rmSync(filePath, { force: true });
      } catch (e) {}
    }
  }

  try {
    execSync(`docker run --rm -v "mc_data_${serverId}:/data" alpine rm -f /data/defaultconfigs/comforts-server.toml /data/config/comforts-server.toml`, { stdio: 'ignore' });
  } catch (e) {
    // ignore
  }
}

export async function syncServerDirToContainer(containerId: string, serverId: string): Promise<void> {
  const config = getConfig();
  const serverDir = path.join(config.dataDir, serverId);
  if (!fs.existsSync(serverDir)) return;

  try {

    validateAndCleanModJars(path.join(serverDir, 'mods'));
    recursivePurgeMods(path.join(serverDir, 'mods'));
    scrubIncompatibleConfigs(serverDir, serverId);

    // Wipe residual old mods/overrides from container volume before extracting fresh archive
    try {
      execSync(`docker run --rm -v "mc_data_${serverId}:/data" alpine rm -rf /data/mods /data/overrides`, { stdio: 'ignore' });
    } catch (e) {
      // ignore
    }

    console.log(`[Docker API putArchive] Stream packing '${serverDir}' into container '${containerId}:/data'...`);
    const container = await getContainerByIdOrName(containerId);

    await new Promise<void>((resolve, reject) => {
      const tarProcess = require('child_process').spawn('tar', ['-cf', '-', '-C', serverDir, '.']);
      
      const putArchivePromise = container.putArchive(tarProcess.stdout, { path: '/data' });
      
      let tarResolved = false;
      let putArchiveResolved = false;

      const checkDone = () => {
        if (tarResolved && putArchiveResolved) resolve();
      };

      putArchivePromise.then(() => {
        putArchiveResolved = true;
        checkDone();
      }).catch(reject);
        
      tarProcess.stderr.on('data', (data: any) => {
        console.warn(`[tar stderr] ${data}`);
      });
      
      tarProcess.on('close', (code: number) => {
        if (code === 0) {
          tarResolved = true;
          checkDone();
        } else {
          reject(new Error(`tar process exited with code ${code}`));
        }
      });

      tarProcess.on('error', (err: any) => {
        reject(err);
      });
    });

    console.log(`[Docker API putArchive] Successfully streamed archive into container volume!`);
  } catch (err: any) {
    console.error(`[Docker API putArchive Error] ${err.message}`);
  }
}

export async function createServerContainer(dto: CreateServerContainerDto): Promise<string> {
  if (!dto.eulaAccepted) {
    throw new Error('EULA must be accepted before creating or running server container.');
  }

  const targetImage = getItzgImageTag(dto.mcVersion);
  await ensureDockerImage(targetImage);

  const config = getConfig();
  const serverDir = path.join(config.dataDir, dto.serverId);

  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(serverDir, 'no-autopause'), '');

  // Setup FabricProxy-Lite config for Velocity Modern Forwarding (Preserved for future opt-in)
  const modsDir = path.join(serverDir, 'mods');
  const configDir = path.join(serverDir, 'config');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'FabricProxy-Lite.toml'), 'secret = "mcmanager-limbo-secret"\n');

  const envVars = [
    `EULA=TRUE`,
    `ONLINE_MODE=FALSE`,
    `ENFORCE_SECURE_PROFILE=FALSE`,
    `ENABLE_AUTOPAUSE=FALSE`,
    `AUTOPAUSE=FALSE`,
    `OVERRIDE_SERVER_PROPERTIES=TRUE`,
    // `FABRIC_PROXY_SECRET=mcmanager-limbo-secret`,
    // `FABRICPROXY_SECRET=mcmanager-limbo-secret`,
    // `MODS=https://cdn.modrinth.com/data/P7dR8mSH/versions/3gT0I5vt/fabric-api-0.156.0%2B26.2.jar,https://cdn.modrinth.com/data/8dI2tmqs/versions/CsEpiziv/FabricProxy-Lite-2.12.0.jar`,
    `MEMORY=${dto.memoryMb}M`,
    `SERVER_PORT=25565`,
    `JVM_OPTS=-Djava.awt.headless=true`,
    `NETWORK_COMPRESSION_THRESHOLD=-1`,
  ];

  // 1. Enforce JAVA_VERSION=17 for MC 1.20.1 or older to prevent Java 21 Guava reflection errors
  const mcVerNum = parseFloat(dto.mcVersion || '1.20.1');
  if (!isNaN(mcVerNum) && mcVerNum <= 1.20) {
    console.log(`[Docker] Enforcing JAVA_VERSION=17 for MC version ${dto.mcVersion || '1.20.1'}`);
    envVars.push('JAVA_VERSION=17');
  }

  if (dto.serverType === 'MODRINTH' && dto.modpackSlug) {
    if (!dto.isMigration) {
      console.log(`[Daemon] Triggering ServerPackCreator CLI workflow for Modrinth modpack '${dto.modpackSlug}'...`);
      let spcSuccess = false;
      try {
        await buildServerWithServerPackCreator({
          serverId: dto.serverId,
          slug: dto.modpackSlug,
          mcVersion: dto.mcVersion,
          targetServerDir: serverDir,
        });
        spcSuccess = true;
      } catch (e: any) {
        console.warn(`[Daemon] ServerPackCreator CLI workflow returned fallback: ${e.message}`);
      }

      if (spcSuccess) {
        console.log(`[Daemon] ServerPackCreator pack generated. Launching container with TYPE=FABRIC.`);
        envVars.push(`TYPE=FABRIC`);
        if (dto.mcVersion && dto.mcVersion !== 'LATEST') {
          envVars.push(`VERSION=${dto.mcVersion}`);
        }
      } else {
        envVars.push(`TYPE=MODRINTH`);
        envVars.push(`MODRINTH_MODPACK=${dto.modpackSlug}`);
        if (dto.mcVersion && dto.mcVersion !== 'LATEST') {
          envVars.push(`VERSION=${dto.mcVersion}`);
        }
        envVars.push(`MODRINTH_SIDE=server`);
        envVars.push(`MODRINTH_EXCLUDE_FILES=${CLIENT_ONLY_DENYLIST.join(',')}`);
        envVars.push(`MODRINTH_OVERRIDES_EXCLUSIONS=mods/missingmodschecker*,mods/*missingmods*,mods/modmenu*,mods/*crashexploitfixer*,mods/*crash*,mods/inventorytabs*`);
        envVars.push(`MODRINTH_FORCE_SYNCHRONIZE=true`);
      }
    } else {
      console.log(`[Daemon] Migration mode: skipping ServerPackCreator for Modrinth. Launching as standard fabric/forge based on original setup if possible, or letting standard MODRINTH env vars handle it.`);
      envVars.push(`TYPE=MODRINTH`);
      envVars.push(`MODRINTH_MODPACK=${dto.modpackSlug}`);
      envVars.push(`MODRINTH_FORCE_SYNCHRONIZE=false`);
    }
  } else if (dto.serverType === 'CURSEFORGE') {
    if (!dto.isMigration) {
      console.log(`[Daemon] Triggering CurseForge modpack workflow for '${dto.modpackSlug}'...`);
      let modId = dto.modId;
      let fileId = dto.fileId;

      if (!modId || !fileId) {
        try {
          const query = dto.modpackSlug || '';
          const searchUrl = isNaN(Number(query)) 
            ? `https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter=${encodeURIComponent(query)}&sortField=2&sortOrder=desc`
            : `https://api.curseforge.com/v1/mods/${query}`;
            
          const searchRes = await fetch(searchUrl, {
            headers: { 'x-api-key': '$2a$10$wEee0b9l2r/F285sC/2ZseBifY4n4.aR5O.E7f3sR3e3nO6wUu.Xq' }
          });
          
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            const mod = isNaN(Number(query)) ? searchData.data[0] : searchData.data;
            if (mod) {
              modId = mod.id;
              fileId = mod.mainFileId;
            }
          }
        } catch (e: any) {
          console.warn(`[Daemon CurseForge Auto-Resolve] ${e.message}`);
        }
      }

      if (modId && fileId) {
        console.log(`[Daemon CurseForge] Deploying CurseForge modpack with ModID ${modId}, FileID ${fileId}...`);
        try {
          await installCurseForgeModpack({
            serverId: dto.serverId,
            modId,
            fileId,
            mcVersion: dto.mcVersion,
            targetServerDir: serverDir,
          });
        } catch (e: any) {
          console.warn(`[Daemon] CurseForge installer returned fallback: ${e.message}`);
        }
      }
    } else {
      console.log(`[Daemon] Migration mode: skipping CurseForge installer.`);
    }

    envVars.push(`TYPE=CURSEFORGE`);
    if (dto.mcVersion && dto.mcVersion !== 'LATEST') {
      envVars.push(`VERSION=${dto.mcVersion}`);
    }
  } else {
    envVars.push(`TYPE=${dto.serverType}`);
    if (dto.mcVersion && dto.mcVersion !== 'LATEST') {
      envVars.push(`VERSION=${dto.mcVersion}`);
    }
  }

  const volumeBind = config.hostDataDir
    ? `${path.join(config.hostDataDir, dto.serverId)}:/data`
    : `mc_data_${dto.serverId}:/data`;

  const containerName = `mc-server-${dto.serverId}`;

  // Pre-cleanup: Stop and remove ANY container bound to the target serverPort or with the same name
  try {
    const allContainers = await docker.listContainers({ all: true });
    for (const cInfo of allContainers) {
      const ports = cInfo.Ports || [];
      const isPortBound = ports.some((p) => p.PublicPort === dto.serverPort);
      const isNameMatch = cInfo.Names.some((n) => n.includes(containerName));

      if (isPortBound || isNameMatch) {
        console.log(`[Docker] Pre-cleanup: Stopping & removing conflicting container '${cInfo.Names.join(', ')}' (${cInfo.Id})...`);
        const conflicting = docker.getContainer(cInfo.Id);
        try { await conflicting.stop({ t: 2 }); } catch (e) {}
        try { await conflicting.remove({ force: true }); } catch (e) {}
      }
    }
  } catch (e) {
    // ignore cleanup errors
  }

  try {
    const container = await docker.createContainer({
      Image: targetImage,
      name: containerName,
      Env: envVars,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        PortBindings: {
          '25565/tcp': [{ HostPort: dto.serverPort.toString() }],
        },
        Binds: [volumeBind],
        Memory: dto.memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(dto.cpuLimit * 1e9),
        Dns: ['8.8.8.8', '1.1.1.1'],
      },
    });

    console.log(`[Docker] Container created successfully: ${container.id}`);

    // Stream server pack files into container volume via Docker putArchive API
    await syncServerDirToContainer(container.id, dto.serverId);

    return container.id;
  } catch (err: any) {
    console.error(`[Docker Error] Failed to create container for server ${dto.serverId}:`, err.message);
    throw new Error(`Docker Engine Container Creation Failed: ${err.message}`);
  }
}

export function validateAndCleanModJars(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      validateAndCleanModJars(fullPath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
      const stats = fs.statSync(fullPath);

      // 1. Check 0-byte or truncated files
      if (stats.size === 0) {
        console.warn(`[Mod Integrity Scanner] Deleting 0-byte corrupted mod JAR: ${entry.name}`);
        try {
          fs.rmSync(fullPath, { force: true });
        } catch (e) {}
        continue;
      }

      // 2. Validate ZIP END header and entry list structure via AdmZip
      try {
        const zip = new AdmZip(fullPath);
        const zipEntries = zip.getEntries();
        if (!zipEntries || zipEntries.length === 0) {
          console.warn(`[Mod Integrity Scanner] Deleting empty or headerless ZIP JAR: ${entry.name}`);
          try {
            fs.rmSync(fullPath, { force: true });
          } catch (e) {}
          continue;
        }
        
        // Do NOT modify the .jar files! Modifying them breaks JAR signatures (.SF / .RSA) 
        // which causes Fabric to reject them with ClassNotFoundException / SecurityException,
        // leading to client/server packet mismatches (DecoderException: IndexOutOfBoundsException).
      } catch (zipErr) {
        console.warn(`[Mod Integrity Scanner] Deleting completely broken ZIP JAR: ${entry.name}`);
        try {
          fs.rmSync(fullPath, { force: true });
        } catch (e) {}
      }
    }
  }
}

function recursivePurgeMods(dir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      recursivePurgeMods(fullPath);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (CLIENT_ONLY_DENYLIST.some((denied) => lower.includes(denied))) {
        console.warn(`[Daemon Mod Sanitize] Purged client-only mod file: ${fullPath}`);
        try {
          fs.rmSync(fullPath, { force: true });
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

const FATAL_PATTERNS = [
  /\[ERROR\]\s*Failed to install Fabric launcher/i,
  /UnknownHostException|DnsNameResolverException/i,
  /\[init\]\s*\[ERROR\]\s*Failed to install/i,
  /Failed to download/i,
];

const MOD_COUNT_PATTERN = /Loading\s+(\d+)\s+mods?:/i;
const READY_PATTERN = /Done \([\d.]+s\)! For help, type "help"/i;

export async function watchContainerStartup(
  containerId: string,
  serverId: string,
  expectedModCount?: number
): Promise<{ status: 'RUNNING' | 'FAILED'; degraded?: boolean; reason?: string }> {
  const container = docker.getContainer(containerId);
  let stream: NodeJS.ReadableStream | null = null;

  try {
    stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
    });
  } catch (err: any) {
    console.warn(`[Daemon Watchdog] Could not attach log watcher to container ${containerId}: ${err.message}`);
    return { status: 'RUNNING' };
  }

  return new Promise((resolve) => {
    let actualModCount: number | null = null;

    const cleanup = () => {
      if (stream) {
        try { (stream as any).destroy(); } catch (e) {}
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ status: 'RUNNING', degraded: true, reason: 'Boot log watcher timed out' });
    }, 180000);

    stream.on('data', async (chunk: Buffer) => {
      const line = chunk.toString('utf8');

      // 1. Fail Fast: Check for fatal launcher/DNS installation errors
      for (const pattern of FATAL_PATTERNS) {
        if (pattern.test(line)) {
          clearTimeout(timeout);
          cleanup();

          const reason = `Fabric loader install failed: ${line.trim()}`;
          console.error(`[Daemon Watchdog Fatal] ${reason}`);
          provisioningManager.emitLog(serverId, 'daemon', `[FATAL ERROR] ${reason}`);
          provisioningManager.emit('status', { serverId, status: STATUS.FAILED, error: reason });

          // Abort and stop the broken container immediately
          try { await container.stop({ t: 2 }); } catch (e) {}

          resolve({ status: 'FAILED', reason });
          return;
        }
      }

      // 2. Parse Fabric loaded mod count
      const modMatch = line.match(MOD_COUNT_PATTERN);
      if (modMatch) {
        actualModCount = parseInt(modMatch[1], 10);
        console.log(`[Daemon Watchdog] Detected ${actualModCount} mods loading on server ${serverId}`);
        provisioningManager.emitLog(serverId, 'daemon', `[Daemon Watchdog] Loaded ${actualModCount} mods into memory`);
      }

      // 3. Ready signal ("Done!")
      if (READY_PATTERN.test(line)) {
        clearTimeout(timeout);
        cleanup();

        let isDegraded = false;
        let reason = 'Server booted cleanly';

        if (expectedModCount && expectedModCount > 10) {
          const minExpected = Math.floor(expectedModCount * 0.5); // 50% threshold
          if (actualModCount === null || actualModCount < minExpected) {
            isDegraded = true;
            reason = `Degraded boot: only ${actualModCount || 0} mods loaded, expected ~${expectedModCount}`;
            console.warn(`[Daemon Watchdog Warning] ${reason}`);
            provisioningManager.emitLog(serverId, 'daemon', `[WARNING] ${reason}`);
          }
        }

        provisioningManager.emit('status', {
          serverId,
          status: STATUS.RUNNING,
          degraded: isDegraded,
          reason,
        });

        resolve({ status: 'RUNNING', degraded: isDegraded, reason });
      }
    });

    stream.on('error', (err) => {
      clearTimeout(timeout);
      cleanup();
      resolve({ status: 'RUNNING', degraded: true, reason: err.message });
    });
  });
}

export async function getContainerByIdOrName(idOrName: string) {
  try {
    const c = docker.getContainer(idOrName);
    await c.inspect();
    return c;
  } catch (e) {
    if (!idOrName.startsWith('mc-server-')) {
      const c = docker.getContainer(`mc-server-${idOrName}`);
      await c.inspect();
      return c;
    }
    throw e;
  }
}

export async function startServerContainer(containerId: string, serverId?: string, expectedModCount?: number): Promise<void> {
  const container = await getContainerByIdOrName(containerId);

  let targetServerId = serverId;
  if (!targetServerId) {
    try {
      const inspect = await container.inspect();
      const match = (inspect.Name || '').replace(/^\//, '').match(/^mc-server-(.+)$/);
      if (match) targetServerId = match[1];
    } catch (e) {}
  }

  if (targetServerId) {
    await syncServerDirToContainer(container.id, targetServerId);
  }

  try {
    await container.start();
  } catch (err: any) {
    if (err.statusCode === 304) {
      console.log(`[Docker] Container ${containerId} is already running.`);
    } else {
      throw err;
    }
  }

  // Tunnel Manager Hook
  if (targetServerId) {
    try {
      const inspect = await container.inspect();
      const ipAddress = inspect.NetworkSettings.IPAddress;
      const portBindings = inspect.HostConfig.PortBindings?.['25565/tcp'];
      if (ipAddress && portBindings && portBindings.length > 0) {
        const publicPort = parseInt(portBindings[0].HostPort, 10);
        await tunnelManager.addTunnel(targetServerId, ipAddress, 25565, publicPort);
      }
    } catch (e: any) {
      console.warn(`[Daemon Tunnel Manager] Failed to register tunnel for ${targetServerId}: ${e.message}`);
    }

    watchContainerStartup(container.id, targetServerId, expectedModCount).catch((e) => {
      console.warn(`[Daemon Watchdog] Error watching startup for server ${targetServerId}:`, e.message);
    });
  }
}

export async function stopServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    const inspect = await container.inspect();
    const match = (inspect.Name || '').replace(/^\//, '').match(/^mc-server-(.+)$/);
    if (match) await tunnelManager.removeTunnel(match[1]);
  } catch(e) {}

  try {
    const exec = await container.exec({
      Cmd: ['rcli', 'stop'],
      AttachStdin: false,
      AttachStdout: false,
    });
    await exec.start({});
  } catch (e) {
    await container.stop({ t: 15 });
  }
}

export async function gracefulStopWithCountdown(containerId: string, seconds: number = 10): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  
  for (let i = seconds; i > 0; i--) {
    try {
      const exec = await container.exec({
        Cmd: ['rcli', `title @a title {"text":"Migration in ${i}s", "color":"red", "bold":true}`],
        AttachStdin: false,
        AttachStdout: false,
      });
      await exec.start({});
      
      const execSubtitle = await container.exec({
        Cmd: ['rcli', `title @a subtitle {"text":"Please wait...", "color":"gray"}`],
        AttachStdin: false,
        AttachStdout: false,
      });
      await execSubtitle.start({});
      
      if (i === seconds) {
         // Also send a chat message on the first second
         const execChat = await container.exec({
           Cmd: ['rcli', `say [SYSTEM] SERVER MIGRATING! Shutting down in ${seconds} seconds...`],
           AttachStdin: false,
           AttachStdout: false,
         });
         await execChat.start({});
      }
    } catch(e) {}
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Stop server
  await stopServerContainer(containerId);
}

export async function restartServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    const inspect = await container.inspect();
    const name = (inspect.Name || '').replace(/^\//, '');
    const match = name.match(/^mc-server-(.+)$/);
    if (match) {
      const serverId = match[1];
      await syncServerDirToContainer(container.id, serverId);
    }
  } catch (e: any) {
    console.warn(`[Daemon Pre-Restart Sync Warning] ${e.message}`);
  }
  await container.restart();
}

export async function killServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    const inspect = await container.inspect();
    const match = (inspect.Name || '').replace(/^\//, '').match(/^mc-server-(.+)$/);
    if (match) await tunnelManager.removeTunnel(match[1]);
  } catch(e) {}
  await container.kill();
}

export async function removeServerContainer(containerId: string, deleteData = false, serverId?: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    await container.stop();
  } catch (e) {
    // ignore
  }
  try {
    await container.remove({ v: true });
  } catch (e) {
    // ignore
  }

  if (serverId) {
    await tunnelManager.removeTunnel(serverId);
  }

  if (deleteData && serverId) {
    const config = getConfig();
    const serverDir = path.join(config.dataDir, serverId);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }
    try {
      const vol = docker.getVolume(`mc_data_${serverId}`);
      await vol.remove({ force: true });
    } catch (e) {
      // ignore
    }
  }
}

export async function getContainerLogsStream(containerId: string) {
  const container = docker.getContainer(containerId);
  return await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 200,
  });
}

export { docker };
