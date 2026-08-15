import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';
import { CreateServerContainerDto } from '@mc-manager/shared';
import { getConfig } from '../../config';
import { sanitizeMrpack, DENYLIST_PATH_SUBSTRINGS } from '../content/modrinth';
import { readInstalledModpack } from '../content/modrinth-provision';
import { buildServerWithServerPackCreator } from '../content/serverpackcreator';
import { installCurseForgeModpack } from '../content/curseforge';
import { provisioningManager, STATUS } from '../content/provisioning';
import { tunnelManager } from '../network/frpc';
import { tryPing } from '../presence/mc-ping';
// presence.ts imports getContainerByIdOrName from here, so this is a cycle. It is safe because
// neither side touches the other at module scope — both only call across inside functions.
import { presenceService } from '../presence/presence';

const docker = new Docker();

/**
 * Client-only mods, shared with the daemon-side mrpack builder so both install paths exclude
 * exactly the same set. Keeping a second copy here is what let `forgeconfigscreens` be filtered
 * on one path and crash the boot on the other.
 */
const CLIENT_ONLY_DENYLIST = DENYLIST_PATH_SUBSTRINGS;

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

export async function syncContainerToHost(serverId: string): Promise<void> {
  const config = getConfig();
  const baseDir = path.resolve(config.dataDir, serverId);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  try {
    const containerName = `mc-server-${serverId}`;
    const container = await getContainerByIdOrName(containerName);
    console.log(`[Daemon Auto-Sync] Extracting live files from container '${containerName}:/data' to '${baseDir}'...`);

    const stream = await container.getArchive({ path: '/data' });
    await new Promise<void>((resolve, reject) => {
      const tar = require('child_process').spawn('tar', ['-xf', '-', '-C', baseDir, '--strip-components=1']);
      stream.pipe(tar.stdin);
      tar.on('close', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed with code ${code}`));
      });
      tar.on('error', reject);
      stream.on('error', reject);
    });
    console.log(`[Daemon Auto-Sync] Container file extraction complete for server ${serverId}.`);
  } catch (err: any) {
    console.warn(`[Daemon Auto-Sync Warning] ${err.message}`);
  }
}

/**
 * Pulls a single file out of the container volume onto the host, so read-only views
 * can inspect live state without paying for a full /data extraction.
 */
export async function syncContainerFileToHost(serverId: string, fileName: string): Promise<boolean> {
  const config = getConfig();
  const baseDir = path.resolve(config.dataDir, serverId);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  try {
    const container = await getContainerByIdOrName(`mc-server-${serverId}`);
    const stream = await container.getArchive({ path: `/data/${fileName}` });
    await new Promise<void>((resolve, reject) => {
      const tar = require('child_process').spawn('tar', ['-xf', '-', '-C', baseDir]);
      stream.pipe(tar.stdin);
      tar.on('close', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed with code ${code}`));
      });
      tar.on('error', reject);
      stream.on('error', reject);
    });
    return true;
  } catch (err: any) {
    // Missing file / no container is an expected case, not a failure worth escalating
    console.warn(`[Daemon File-Sync Warning] ${serverId}:${fileName} - ${err.message}`);
    return false;
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
  if (!fs.existsSync(path.join(configDir, 'FabricProxy-Lite.toml'))) {
    fs.writeFileSync(path.join(configDir, 'FabricProxy-Lite.toml'), 'secret = "mcmanager-limbo-secret"\n');
  }

  const envVars = [
    `EULA=TRUE`,
    `ONLINE_MODE=${process.env.ONLINE_MODE || 'TRUE'}`,
    `ENFORCE_SECURE_PROFILE=FALSE`,
    `ENABLE_AUTOPAUSE=FALSE`,
    `AUTOPAUSE=FALSE`,
    `OVERRIDE_SERVER_PROPERTIES=FALSE`,
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
    // The pack is built once, by the daemon, before the container is ever created — see
    // provisionModrinthPack. When that has already happened the directory holds a complete
    // server, so the container's job is only to run it. Letting the image fetch the modpack
    // again here would download it a second time and fight the files already on disk.
    const prebuilt = readInstalledModpack(serverDir);

    if (prebuilt && !dto.isMigration) {
      const typeForLoader: Record<string, string> = {
        fabric: 'FABRIC',
        quilt: 'QUILT',
        forge: 'FORGE',
        neoforge: 'NEOFORGE',
        vanilla: 'VANILLA',
      };
      const resolvedType = typeForLoader[prebuilt.loader] || 'FABRIC';
      console.log(
        `[Daemon] Modpack '${dto.modpackSlug}' is already built (${prebuilt.loader}, ` +
        `${prebuilt.modsDownloaded} mods) — launching container with TYPE=${resolvedType}.`
      );
      envVars.push(`TYPE=${resolvedType}`);

      const version = prebuilt.mcVersion || dto.mcVersion;
      if (version && version !== 'LATEST') envVars.push(`VERSION=${version}`);
    } else if (!dto.isMigration) {
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
      console.log(`[Daemon] Migration mode: preserving pre-built server files for Modrinth server.`);
      let detectedType = 'FABRIC';
      if (fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'))) {
        detectedType = 'FORGE';
      }
      envVars.push(`TYPE=${detectedType}`);
      if (dto.mcVersion && dto.mcVersion !== 'LATEST') {
        envVars.push(`VERSION=${dto.mcVersion}`);
      }
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
      console.log(`[Daemon] Migration mode: preserving pre-built server files for CurseForge server.`);
    }

    if (dto.isMigration) {
      let detectedType = 'FABRIC';
      if (fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'))) {
        detectedType = 'FORGE';
      }
      envVars.push(`TYPE=${detectedType}`);
    } else {
      envVars.push(`TYPE=CURSEFORGE`);
    }
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
          '25565/tcp': [{ HostIp: '0.0.0.0', HostPort: dto.serverPort.toString() }],
          // BlueMap's web server. Published up front because Docker cannot add a
          // port binding to an existing container — it would need recreating.
          ...(dto.bluemapPort
            ? { '8100/tcp': [{ HostIp: '0.0.0.0', HostPort: dto.bluemapPort.toString() }] }
            : {}),
        },
        Binds: [volumeBind],
        Memory: dto.memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(dto.cpuLimit * 1e9),
        Dns: ['8.8.8.8', '1.1.1.1'],
        // Docker itself brings the container back after a host reboot or Docker Engine
        // restart, independent of the panel's own crash-restart logic (which only
        // fires while the daemon is up to observe the crash).
        RestartPolicy: { Name: 'unless-stopped' },
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

/**
 * How long a container gets to reach "accepting connections" before the watchdog gives up.
 * Large modpacks legitimately need far longer than a vanilla server — hundreds of mods plus
 * first-run world generation routinely runs past ten minutes — so the budget is generous and
 * overridable per deployment.
 */
const BOOT_BUDGET_MS = Number(process.env.BOOT_TIMEOUT_MS) || 30 * 60 * 1000;
const BOOT_PING_INTERVAL_MS = 10000;

/**
 * Every address the daemon might reach this container's Minecraft port on. The daemon runs on
 * the host in some deployments and inside a container in others, so rather than guess we try
 * each candidate and keep whichever answers.
 */
async function resolveProbeTargets(container: Docker.Container): Promise<Array<{ host: string; port: number }>> {
  const targets: Array<{ host: string; port: number }> = [];
  try {
    const inspect = await container.inspect();

    const containerIp = inspect.NetworkSettings?.IPAddress;
    if (containerIp) targets.push({ host: containerIp, port: 25565 });

    const binding = inspect.HostConfig?.PortBindings?.['25565/tcp']?.[0]?.HostPort;
    if (binding) {
      const port = parseInt(binding, 10);
      targets.push({ host: '127.0.0.1', port });
      if (process.env.HOST_IP) targets.push({ host: process.env.HOST_IP, port });
      targets.push({ host: 'host.docker.internal', port });
    }
  } catch (e: any) {
    console.warn(`[Daemon Watchdog] Could not inspect container for probe targets: ${e.message}`);
  }
  return targets;
}

/**
 * Watches a freshly started container until the Minecraft server is genuinely joinable.
 *
 * Readiness is confirmed two independent ways — the "Done (…)" log line and a real status ping
 * against the server port — because a boot can succeed without the watcher ever seeing that log
 * line (dropped log stream, non-standard launch script, restored container). The watchdog never
 * reports RUNNING on a timeout: a server that has not answered a ping is not one a player can
 * join, and claiming otherwise is exactly what makes the panel show RUNNING while the client
 * sees "Can't connect to server".
 */
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
    // Losing the log stream is survivable — the ping probe below is authoritative on its own.
    console.warn(`[Daemon Watchdog] Could not attach log watcher to container ${containerId}: ${err.message}`);
  }

  return new Promise((resolve) => {
    let actualModCount: number | null = null;
    let settled = false;
    let pingTimer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();

    const cleanup = () => {
      if (pingTimer) clearInterval(pingTimer);
      clearTimeout(timeout);
      if (stream) {
        try { (stream as any).destroy(); } catch (e) {}
      }
    };

    const succeed = (via: string) => {
      if (settled) return;
      settled = true;
      cleanup();

      let isDegraded = false;
      let reason = `Server booted cleanly (confirmed via ${via})`;

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
    };

    const fail = (reason: string, stopContainer: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();

      console.error(`[Daemon Watchdog Fatal] ${reason}`);
      provisioningManager.emitLog(serverId, 'daemon', `[FATAL ERROR] ${reason}`);
      provisioningManager.emit('status', { serverId, status: STATUS.FAILED, error: reason });

      if (stopContainer) {
        container.stop({ t: 2 }).catch(() => {});
      }

      resolve({ status: 'FAILED', reason });
    };

    const timeout = setTimeout(() => {
      fail(
        `Server never accepted connections within ${Math.round(BOOT_BUDGET_MS / 60000)} minutes — ` +
          `it is still starting, stuck, or crashed. Check the console for the last error.`,
        false
      );
    }, BOOT_BUDGET_MS);

    // Probe the server port until it answers a real status ping. That is what actually proves a
    // player can connect, and it is the only signal that survives a missing "Done" line.
    (async () => {
      const targets = await resolveProbeTargets(container);
      if (targets.length === 0 || settled) return;

      pingTimer = setInterval(async () => {
        if (settled) return;
        for (const t of targets) {
          if (await tryPing(t.host, t.port, 2000)) {
            succeed(`status ping ${t.host}:${t.port}`);
            return;
          }
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs % (5 * 60000) < BOOT_PING_INTERVAL_MS) {
          provisioningManager.emitLog(
            serverId,
            'daemon',
            `[Daemon Watchdog] Still booting after ${Math.round(elapsedMs / 60000)}m — not accepting connections yet.`
          );
        }
      }, BOOT_PING_INTERVAL_MS);
    })();

    // A container that exits before it is ready has crashed, however clean its logs looked.
    container
      .wait()
      .then((res: any) => {
        fail(`Server process exited during startup with code ${res?.StatusCode ?? 'unknown'}`, false);
      })
      .catch(() => {});

    if (stream) {
      stream.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8');

        // 1. Fail Fast: Check for fatal launcher/DNS installation errors
        for (const pattern of FATAL_PATTERNS) {
          if (pattern.test(line)) {
            fail(`Fabric loader install failed: ${line.trim()}`, true);
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
          succeed('boot log');
        }
      });

      stream.on('error', (err) => {
        // Not a verdict — let the ping probe decide whether the server came up.
        console.warn(`[Daemon Watchdog] Log stream for ${serverId} ended early: ${err.message}`);
      });
    }
  });
}

/**
 * Backfills the `unless-stopped` restart policy onto Minecraft server containers created
 * before it became the default, so a host reboot / Docker Engine restart brings them back
 * without requiring every server to be recreated. Called once at daemon startup.
 */
export async function ensureContainerRestartPolicies(): Promise<void> {
  try {
    const containers = await docker.listContainers({ all: true, filters: { name: ['mc-server-'] } });
    for (const c of containers) {
      if ((c.HostConfig as any)?.RestartPolicy?.Name === 'unless-stopped') continue;
      try {
        await docker.getContainer(c.Id).update({ RestartPolicy: { Name: 'unless-stopped' } } as any);
      } catch (e: any) {
        console.warn(`[Docker] Failed to backfill restart policy on ${c.Names?.[0] || c.Id}:`, e.message);
      }
    }
  } catch (e: any) {
    console.warn('[Docker] Restart policy backfill skipped:', e.message);
  }
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
      const portBindings = inspect.HostConfig.PortBindings?.['25565/tcp'];
      if (portBindings && portBindings.length > 0) {
        const publicPort = parseInt(portBindings[0].HostPort, 10);
        const targetLocalIp = process.env.HOST_IP || 'host.docker.internal';
        console.log(`[Daemon Tunnel Manager] Registering tunnel for server ${targetServerId}: ${targetLocalIp}:${publicPort} -> remote:${publicPort}`);
        await tunnelManager.addTunnel(targetServerId, targetLocalIp, publicPort, publicPort);
      } else {
        console.warn(`[Daemon Tunnel Manager] Missing PortBinding for ${targetServerId}. PortBindings:`, portBindings);
      }
    } catch (e: any) {
      console.warn(`[Daemon Tunnel Manager] Failed to register tunnel for ${targetServerId}: ${e.message}`);
    }

    watchContainerStartup(container.id, targetServerId, expectedModCount).catch((e) => {
      console.warn(`[Daemon Watchdog] Error watching startup for server ${targetServerId}:`, e.message);
    });

    // Attaches its own log stream, separate from the console websocket, so player sessions are
    // recorded whether or not anyone has the panel open.
    presenceService.trackContainer(targetServerId).catch(() => {});
  }
}

export async function stopServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    const inspect = await container.inspect();
    const match = (inspect.Name || '').replace(/^\//, '').match(/^mc-server-(.+)$/);
    if (match) {
      await tunnelManager.removeTunnel(match[1]);
      // Closes every open session now rather than leaving players accruing playtime while the
      // server is down.
      presenceService.serverStopped(match[1]);
    }
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

export async function registerContainerTunnel(container: any, serverId: string) {
  try {
    const inspect = await container.inspect();
    const portBindings = inspect.HostConfig.PortBindings?.['25565/tcp'];
    if (portBindings && portBindings.length > 0) {
      const publicPort = parseInt(portBindings[0].HostPort, 10);
      const targetLocalIp = process.env.HOST_IP || 'host.docker.internal';
      console.log(`[Daemon Tunnel Manager] Registering tunnel for server ${serverId}: ${targetLocalIp}:${publicPort} -> remote:${publicPort}`);
      await tunnelManager.addTunnel(serverId, targetLocalIp, publicPort, publicPort);
    } else {
      console.warn(`[Daemon Tunnel Manager] Missing PortBinding for ${serverId}.`);
    }
  } catch (e: any) {
    console.warn(`[Daemon Tunnel Manager] Failed to register tunnel for ${serverId}: ${e.message}`);
  }
}

export async function restartServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  let targetServerId = '';
  try {
    const inspect = await container.inspect();
    const name = (inspect.Name || '').replace(/^\//, '');
    const match = name.match(/^mc-server-(.+)$/);
    if (match) {
      targetServerId = match[1];
      await syncServerDirToContainer(container.id, targetServerId);
    }
  } catch (e: any) {
    console.warn(`[Daemon Pre-Restart Sync Warning] ${e.message}`);
  }
  await container.restart();

  if (targetServerId) {
    await registerContainerTunnel(container, targetServerId);
  }
}

export async function killServerContainer(containerId: string): Promise<void> {
  const container = await getContainerByIdOrName(containerId);
  try {
    const inspect = await container.inspect();
    const match = (inspect.Name || '').replace(/^\//, '').match(/^mc-server-(.+)$/);
    if (match) {
      await tunnelManager.removeTunnel(match[1]);
      presenceService.serverStopped(match[1]);
    }
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
    presenceService.serverStopped(serverId);
  }

  if (deleteData && serverId) {
    const config = getConfig();
    const serverDir = path.join(config.dataDir, serverId);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    try {
      const vol = docker.getVolume(`mc_data_${serverId}`);
      await vol.remove({ force: true });
    } catch (e) {
      // ignore
    }
  }
}

/**
 * Rolling in-memory sample buffer, mirroring what processManager keeps for PROCESS mode so the
 * panel's chart has something to draw before the DB's long-term ServerStatSample history fills in.
 * Keyed by the bare server id. Deliberately not persisted — it is a warm-up buffer, not a record.
 */
const containerStatsHistory = new Map<string, Array<{ timestamp: string; cpuPercent: number; memoryMb: number }>>();
const CONTAINER_HISTORY_POINTS = 60;

export function getContainerStatsHistory(serverId: string) {
  return containerStatsHistory.get(serverId.replace(/^mc-server-/, '')) || [];
}

/**
 * One-shot resource sample for a running container.
 *
 * `stats({ stream: false })` returns a single snapshot that already carries the previous reading
 * in `precpu_stats`, so the delta below needs no state of our own — but it also means Docker has
 * to hold the request open for its sample interval (~1s), which is why callers should sample
 * containers concurrently rather than in a loop.
 *
 * Returns null rather than zeroes when the container is stopped or the daemon refuses, so the
 * panel can tell "no data" apart from "genuinely idle".
 */
export async function getContainerStats(
  containerId: string
): Promise<{ cpuPercent: number; memoryMb: number; memoryLimitMb: number | null } | null> {
  try {
    const container = await getContainerByIdOrName(containerId);
    const s: any = await container.stats({ stream: false });

    const cpuDelta = (s?.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s?.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (s?.cpu_stats?.system_cpu_usage ?? 0) - (s?.precpu_stats?.system_cpu_usage ?? 0);

    // online_cpus is absent on older daemons; percpu_usage length is the documented fallback.
    const cpuCount = s?.cpu_stats?.online_cpus || s?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

    let cpuPercent = 0;
    if (cpuDelta > 0 && systemDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
    }

    // `usage` counts the page cache, which for a Minecraft server is mostly world chunks read
    // off disk — subtracting it is what `docker stats` itself reports and is the number that
    // matches what the JVM actually holds.
    const usage = s?.memory_stats?.usage ?? 0;
    const cache = s?.memory_stats?.stats?.inactive_file ?? s?.memory_stats?.stats?.total_inactive_file ?? s?.memory_stats?.stats?.cache ?? 0;
    const memoryBytes = Math.max(0, usage - cache);
    const limitBytes = s?.memory_stats?.limit ?? 0;

    const sample = {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMb: Math.round(memoryBytes / 1024 / 1024),
      // An unconstrained container reports the host's total RAM; that is not a useful "limit".
      memoryLimitMb: limitBytes > 0 && limitBytes < 1024 * 1024 * 1024 * 1024 ? Math.round(limitBytes / 1024 / 1024) : null,
    };

    const key = containerId.replace(/^mc-server-/, '');
    const history = containerStatsHistory.get(key) || [];
    history.push({ timestamp: new Date().toLocaleTimeString(), cpuPercent: sample.cpuPercent, memoryMb: sample.memoryMb });
    if (history.length > CONTAINER_HISTORY_POINTS) history.splice(0, history.length - CONTAINER_HISTORY_POINTS);
    containerStatsHistory.set(key, history);

    return sample;
  } catch (e: any) {
    return null;
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
