import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { loadConfig } from '../config';
import {
  createServerContainer,
  startServerContainer,
  stopServerContainer,
  gracefulStopWithCountdown,
  restartServerContainer,
  killServerContainer,
  removeServerContainer,
  syncServerDirToContainer,
  syncContainerToHost,
  getContainerByIdOrName,
  getItzgImageTag,
  ensureDockerImage,
} from '../services/docker';
import { provisioningManager } from '../services/provisioning';
import { processManager } from '../services/process';
import { backupManager } from '../services/backup';
import { CreateServerContainerDto, ExecutionMode } from '@mc-manager/shared';
import { PrismaClient } from '@prisma/client';
import { flattenServerDir } from '../utils/flatten';

const router = Router();
const config = loadConfig();
const prisma = new PrismaClient();

// POST /api/v1/servers/create
router.post('/create', async (req: Request, res: Response) => {
  try {
    const dto: CreateServerContainerDto = req.body;
    console.log('[Daemon API] Received server creation request:', JSON.stringify(dto));

    if (!dto.serverId || !dto.serverType || !dto.serverPort) {
      return res.status(400).json({ error: 'Missing required parameters: serverId, serverType, serverPort' });
    }

    const isProcessMode = dto.executionMode === ExecutionMode.PROCESS;
    const generatedContainerId = isProcessMode ? `process-${dto.serverId}` : `mc-server-${dto.serverId}`;

    // Prepare directory, metadata, and server.properties without launching process
    const serverDir = path.join(config.dataDir, dto.serverId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
    fs.writeFileSync(path.join(serverDir, 'craftcontrol-meta.json'), JSON.stringify(dto, null, 2));
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    // Pre-download server jar in background non-blocking so starting later is instant
    provisioningManager.run(dto.serverId, async () => {
      await processManager.ensureServerJar(serverDir, dto);
      if (!isProcessMode) {
        await createServerContainer(dto);
      }
    }).catch((err) => {
      console.error(`[Daemon Background Prepare Failed] ${dto.serverId}:`, err.message);
    });

    // Respond with OFFLINE status - server will only start when user explicitly clicks Start button
    res.status(202).json({
      message: 'Server created successfully',
      serverId: dto.serverId,
      containerId: generatedContainerId,
      status: 'OFFLINE',
    });
  } catch (err: any) {
    console.error('[Daemon API Error] Creation failed:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to create server', details: err.message });
  }
});

// Helper function for processing and extracting serverpack archives
async function processAndExtractServerpack(serverId: string, archivePath: string, res: Response) {
  const serverDir = path.join(config.dataDir, serverId);

  console.log(`[Daemon API] Serverpack archive saved to disk, detecting format & extracting...`);
  
  // Detect format (ZIP vs RAR) and extract using native CLI tools or WASM fallback
  const headerBuf = Buffer.alloc(8);
  const fd = fs.openSync(archivePath, 'r');
  fs.readSync(fd, headerBuf, 0, 8, 0);
  fs.closeSync(fd);

  const isRar = headerBuf[0] === 0x52 && headerBuf[1] === 0x61 && headerBuf[2] === 0x72 && headerBuf[3] === 0x21; // "Rar!"
  console.log(`[Daemon Archive Extractor] Detected archive format for '${serverId}': ${isRar ? 'RAR' : 'ZIP'}`);

  // Count files before extraction to verify something was extracted
  const filesBefore = fs.readdirSync(serverDir).length;

  if (isRar) {
    let extracted = false;
    const commands = [
      `unrar x -o+ "${archivePath}" "${serverDir}/"`,
      `7z x "${archivePath}" -o"${serverDir}" -y`,
      `7za x "${archivePath}" -o"${serverDir}" -y`,
      `bsdtar -xf "${archivePath}" -C "${serverDir}"`,
    ];

    for (const cmd of commands) {
      try {
        const output = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
        console.log(`[Daemon Archive Extractor] Extracted RAR using: ${cmd.split(' ')[0]}`);
        extracted = true;
        break;
      } catch (e: any) {
        console.log(`[Daemon Archive Extractor] Failed with ${cmd.split(' ')[0]}: ${e.message}`);
      }
    }

    if (!extracted) {
      console.log(`[Daemon Archive Extractor] Running node-unrar-js WASM fallback...`);
      try {
        const unrar = require('node-unrar-js');
        const fileData = fs.readFileSync(archivePath);
        const extractor = await unrar.createExtractorFromData({ data: fileData });
        const unrarResult = extractor.extract({ files: () => true });
        let filesExtracted = 0;
        for (const file of unrarResult.files) {
          const fullDest = path.join(serverDir, file.fileHeader.name);
          if (file.fileHeader.flags.directory) {
            fs.mkdirSync(fullDest, { recursive: true });
          } else if (file.extraction) {
            fs.mkdirSync(path.dirname(fullDest), { recursive: true });
            fs.writeFileSync(fullDest, Buffer.from(file.extraction));
            filesExtracted++;
          }
        }
        console.log(`[Daemon Archive Extractor] WASM fallback extracted ${filesExtracted} files`);
        extracted = true;
      } catch (e: any) {
        console.error(`[Daemon Archive Extractor] WASM fallback failed: ${e.message}`);
        throw new Error(`All RAR extraction methods failed: ${e.message}`);
      }
    }
  } else {
    let extracted = false;
    const commands = [
      `unzip -q -o "${archivePath}" -d "${serverDir}"`,
      `7z x "${archivePath}" -o"${serverDir}" -y`,
      `bsdtar -xf "${archivePath}" -C "${serverDir}"`,
      `tar -xf "${archivePath}" -C "${serverDir}"`,
    ];

    for (const cmd of commands) {
      try {
        const output = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
        console.log(`[Daemon Archive Extractor] Extracted ZIP using: ${cmd.split(' ')[0]}`);
        extracted = true;
        break;
      } catch (e: any) {
        console.log(`[Daemon Archive Extractor] Failed with ${cmd.split(' ')[0]}: ${e.message}`);
      }
    }

    if (!extracted) {
      console.log(`[Daemon Archive Extractor] Running AdmZip fallback...`);
      try {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(serverDir, true);
        extracted = true;
      } catch (e: any) {
        console.error(`[Daemon Archive Extractor] AdmZip fallback failed: ${e.message}`);
        throw new Error(`All ZIP extraction methods failed: ${e.message}`);
      }
    }
  }

  // Verify extraction actually happened
  const filesAfter = fs.readdirSync(serverDir).length;
  if (filesAfter <= filesBefore) {
    const allFiles = fs.readdirSync(serverDir);
    throw new Error(`Archive extraction failed: no files were extracted from the archive. Files before: ${filesBefore}, after: ${filesAfter}. Current files: ${allFiles.join(', ')}`);
  }
  console.log(`[Daemon Archive Extractor] Extraction verified: ${filesAfter - filesBefore} new files created (before: ${filesBefore}, after: ${filesAfter})`);
  console.log(`[Daemon Archive Extractor] Files in directory after extraction: ${fs.readdirSync(serverDir).join(', ')}`);

  fs.rmSync(archivePath, { force: true });
  
  // Fix permissions so the server process / container can access files
  try {
    execSync(`chown -R 1000:1000 "${serverDir}"`);
    execSync(`chmod -R 775 "${serverDir}"`);
  } catch (e) {}

  console.log(`[Daemon API] Serverpack archive extracted into '${serverDir}'`);

  // Smart Nested Directory Flattening
  flattenServerDir(serverDir);
  let items = fs.readdirSync(serverDir);
  console.log(`[Daemon Extractor] Directory contents after flattening (${items.length} items): ${items.join(', ')}`);

  // Smart Launch Script Detection: Check for run.sh or run.bat (preferred for modpacks)
  let launchScript: string | null = null;
  const runShPath = path.join(serverDir, 'run.sh');
  const runBatPath = path.join(serverDir, 'run.bat');
  
  if (fs.existsSync(runShPath)) {
    console.log(`[Daemon Extractor] Found run.sh launch script, using as primary executable`);
    launchScript = 'run.sh';
    try {
      execSync(`chmod +x "${runShPath}"`);
    } catch (e) {}

    // Strip Windows CRLF line endings from run.sh and companion arg files eagerly
    // (server packs created on Windows have \r\n endings, causing silent bash exit 0)
    for (const f of ['run.sh', 'user_jvm_args.txt', 'unix_args.txt', 'user_args.txt']) {
      const fp = path.join(serverDir, f);
      if (fs.existsSync(fp)) {
        try {
          const raw = fs.readFileSync(fp, 'utf8');
          if (raw.includes('\r')) {
            fs.writeFileSync(fp, raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
            console.log(`[Daemon Extractor] Stripped CRLF from ${f}`);
          }
        } catch (e) {}
      }
    }
  } else if (fs.existsSync(runBatPath)) {
    console.log(`[Daemon Extractor] Found run.bat launch script, using as primary executable`);
    launchScript = 'run.bat';
  }

  // If no launch script, search for server.jar
  let serverJarPath = path.join(serverDir, 'server.jar');
  if (!launchScript && !fs.existsSync(serverJarPath)) {
    console.log(`[Daemon Extractor] No launch script found, searching for server.jar...`);
    items = fs.readdirSync(serverDir);
    for (const item of items) {
      const itemPath = path.join(serverDir, item);
      if (fs.statSync(itemPath).isDirectory()) {
        const potentialJarPath = path.join(itemPath, 'server.jar');
        if (fs.existsSync(potentialJarPath)) {
          console.log(`[Daemon Extractor] Found server.jar in subdirectory '${item}', moving to root...`);
          const subItems = fs.readdirSync(itemPath);
          for (const subItem of subItems) {
            fs.renameSync(path.join(itemPath, subItem), path.join(serverDir, subItem));
          }
          fs.rmdirSync(itemPath);
          serverJarPath = path.join(serverDir, 'server.jar');
          break;
        }
      }
    }
  }

  // Fallback: If still no server.jar and no launch script, search for ANY jar file at root
  if (!launchScript && !fs.existsSync(serverJarPath)) {
    console.log(`[Daemon Extractor] server.jar not found, searching for any .jar file at root...`);
    const rootJars = fs.readdirSync(serverDir).filter((f: string) => f.toLowerCase().endsWith('.jar'));
    if (rootJars.length > 0) {
      console.log(`[Daemon Extractor] Found jar file: ${rootJars[0]}, using as server executable`);
      serverJarPath = path.join(serverDir, rootJars[0]);
    }
  }

  // Fallback: Search for any jar file in subdirectories and move it to root
  if (!launchScript && !fs.existsSync(serverJarPath)) {
    console.log(`[Daemon Extractor] No jar at root, searching subdirectories for any .jar file...`);
    items = fs.readdirSync(serverDir);
    for (const item of items) {
      const itemPath = path.join(serverDir, item);
      if (fs.statSync(itemPath).isDirectory()) {
        const jarFiles = fs.readdirSync(itemPath).filter((f: string) => f.toLowerCase().endsWith('.jar'));
        if (jarFiles.length > 0) {
          console.log(`[Daemon Extractor] Found jar file in subdirectory '${item}': ${jarFiles[0]}, moving to root...`);
          const subItems = fs.readdirSync(itemPath);
          for (const subItem of subItems) {
            fs.renameSync(path.join(itemPath, subItem), path.join(serverDir, subItem));
          }
          fs.rmdirSync(itemPath);
          serverJarPath = path.join(serverDir, jarFiles[0]);
          break;
        }
      }
    }
  }

  // Verify either launch script or jar file exists
  if (!launchScript && !fs.existsSync(serverJarPath)) {
    const availableFiles = fs.readdirSync(serverDir).slice(0, 20).join(', ');
    throw new Error(
      `Server archive does not contain a launch script (run.sh/run.bat) or .jar executable file. ` +
      `Archive contents: ${availableFiles}${fs.readdirSync(serverDir).length > 20 ? ', ...' : ''}. ` +
      `Make sure the archive is a valid server pack with either run.sh/run.bat or a jar executable.`
    );
  }

  if (launchScript) {
    console.log(`[Daemon Extractor] ✓ Verified launch script exists: ${launchScript}`);
  } else {
    console.log(`[Daemon Extractor] ✓ Verified jar executable exists at ${serverJarPath}`);
  }

  // Smart Serverpack Minecraft Version Auto-Detection & Version Lock
  let detectedMcVersion: string | null = null;
  try {
    const manifestPath = path.join(serverDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.minecraft && manifest.minecraft.version) {
        detectedMcVersion = manifest.minecraft.version;
      }
    }

    if (!detectedMcVersion) {
      const modrinthIndexPath = path.join(serverDir, 'modrinth.index.json');
      if (fs.existsSync(modrinthIndexPath)) {
        const indexJson = JSON.parse(fs.readFileSync(modrinthIndexPath, 'utf8'));
        if (indexJson.dependencies && indexJson.dependencies.minecraft) {
          detectedMcVersion = indexJson.dependencies.minecraft;
        }
      }
    }

    if (!detectedMcVersion) {
      const spcPropsPath = path.join(serverDir, 'serverpackcreator.properties');
      if (fs.existsSync(spcPropsPath)) {
        const content = fs.readFileSync(spcPropsPath, 'utf8');
        const match = content.match(/minecraft\.version=([^\r\n]+)/);
        if (match) detectedMcVersion = match[1].trim();
      }
    }

    if (!detectedMcVersion) {
      const argsPath = fs.existsSync(path.join(serverDir, 'user_args.txt'))
        ? path.join(serverDir, 'user_args.txt')
        : (fs.existsSync(path.join(serverDir, 'unix_args.txt')) ? path.join(serverDir, 'unix_args.txt') : null);
      if (argsPath) {
        const content = fs.readFileSync(argsPath, 'utf8');
        const match = content.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (match) detectedMcVersion = match[1];
      }
    }

    if (!detectedMcVersion) {
      const files = fs.readdirSync(serverDir);
      for (const file of files) {
        const match = file.match(/(?:fabric|forge|neoforge|paper|purpur|spigot|vanilla|server|minecraft)[_-]?(?:loader|server|installer)?[_-]?(\d+\.\d+(?:\.\d+)?)/i);
        if (match) {
          detectedMcVersion = match[1];
          break;
        }
      }
    }
  } catch (detectErr: any) {
    console.warn(`[Daemon Extractor Warning] Version auto-detection failed:`, detectErr.message);
  }

  // Always flag serverpack as version locked
  const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
  let meta: any = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
  }
  meta.versionLocked = true;

  if (detectedMcVersion) {
    console.log(`[Daemon Extractor] Auto-detected version '${detectedMcVersion}' from serverpack. Locking server version...`);
    meta.mcVersion = detectedMcVersion;
    meta.installedVersion = detectedMcVersion;

    try {
      await prisma.server.update({
        where: { id: serverId },
        data: { mcVersion: detectedMcVersion },
      });
    } catch (dbErr: any) {
      console.warn(`[Daemon Extractor Warning] Failed to sync detected mcVersion to DB:`, dbErr.message);
    }
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Sync extracted serverpack files into container volume if running in Docker mode
  const containerName = `mc-server-${serverId}`;
  try {
    await syncServerDirToContainer(containerName, serverId);
  } catch (syncErr: any) {
    // ignore container sync if process mode
  }

  res.json({ message: 'Serverpack archive extracted successfully', serverId, detectedVersion: detectedMcVersion });
}

// POST /api/v1/servers/:serverId/upload-pack
router.post('/:serverId/upload-pack', async (req: Request, res: Response) => {
  try {
    const { serverId } = req.params;
    console.log(`[Daemon API] Receiving streaming serverpack archive (ZIP/RAR) upload for serverId '${serverId}'...`);

    const serverDir = path.join(config.dataDir, serverId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const archivePath = path.join(serverDir, 'serverpack_uploaded.tmp');
    
    // Stream directly to disk to prevent RAM exhaustion and event loop blocking
    const writeStream = fs.createWriteStream(archivePath);
    req.pipe(writeStream);
    
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    await processAndExtractServerpack(serverId, archivePath, res);
  } catch (err: any) {
    console.error(`[Daemon API Error] Upload pack failed:`, err.message);
    res.status(500).json({ error: 'Failed to extract serverpack archive', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/upload-chunk
router.post('/:serverId/upload-chunk', async (req: Request, res: Response) => {
  try {
    const { serverId } = req.params;
    const uploadId = (req.headers['x-upload-id'] || req.query.uploadId) as string;
    const chunkIndexStr = (req.headers['x-chunk-index'] || req.query.chunkIndex) as string;

    if (!uploadId || chunkIndexStr === undefined || chunkIndexStr === null) {
      return res.status(400).json({ error: 'Missing x-upload-id or x-chunk-index header' });
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    if (isNaN(chunkIndex)) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }

    const uploadTmpDir = path.join(config.dataDir, serverId, '.tmp_uploads', uploadId);
    if (!fs.existsSync(uploadTmpDir)) {
      fs.mkdirSync(uploadTmpDir, { recursive: true });
    }

    const chunkFilePath = path.join(uploadTmpDir, `chunk_${chunkIndex}`);
    const writeStream = fs.createWriteStream(chunkFilePath);
    req.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    res.json({ success: true, chunkIndex });
  } catch (err: any) {
    console.error(`[Daemon API Error] Upload chunk failed:`, err.message);
    res.status(500).json({ error: 'Failed to upload chunk', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/upload-complete
router.post('/:serverId/upload-complete', async (req: Request, res: Response) => {
  try {
    const { serverId } = req.params;
    const { uploadId, fileName, totalChunks, isServerpack = true, targetPath = '' } = req.body;

    if (!uploadId || !totalChunks || totalChunks <= 0) {
      return res.status(400).json({ error: 'Missing required parameters: uploadId, totalChunks' });
    }

    const serverDir = path.join(config.dataDir, serverId);
    const uploadTmpDir = path.join(serverDir, '.tmp_uploads', uploadId);

    if (!fs.existsSync(uploadTmpDir)) {
      return res.status(404).json({ error: 'Upload directory not found for this uploadId' });
    }

    // Verify all chunks exist
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(uploadTmpDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        return res.status(400).json({ error: `Missing chunk index ${i} of ${totalChunks}` });
      }
    }

    let destinationPath: string;
    if (isServerpack) {
      destinationPath = path.join(serverDir, 'serverpack_uploaded.tmp');
    } else {
      const cleanRel = path.normalize(targetPath || '').replace(/^(\.\.[\/\\])+/, '');
      const folderDir = path.join(serverDir, cleanRel);
      destinationPath = path.join(folderDir, fileName || 'uploaded_file');

      if (!destinationPath.startsWith(serverDir)) {
        return res.status(403).json({ error: 'Invalid file path (path traversal forbidden)' });
      }
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    }

    // Assemble chunks into destination file
    const destStream = fs.createWriteStream(destinationPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(uploadTmpDir, `chunk_${i}`);
      const chunkBuffer = fs.readFileSync(chunkPath);
      destStream.write(chunkBuffer);
    }
    destStream.end();

    await new Promise<void>((resolve, reject) => {
      destStream.on('finish', resolve);
      destStream.on('error', reject);
    });

    // Cleanup temporary upload directory
    fs.rmSync(uploadTmpDir, { recursive: true, force: true });

    if (isServerpack) {
      return await processAndExtractServerpack(serverId, destinationPath, res);
    }

    // Fix file permissions
    try {
      execSync(`chown -R 1000:1000 "${destinationPath}"`);
      execSync(`chmod -R 775 "${destinationPath}"`);
    } catch (e) {}

    res.json({ message: 'File assembled and uploaded successfully', path: destinationPath });
  } catch (err: any) {
    console.error(`[Daemon API Error] Upload complete failed:`, err.message);
    res.status(500).json({ error: 'Failed to complete chunked upload', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/icon
router.get('/:serverId/icon', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const serverDir = path.join(config.dataDir, serverId);
  const iconPath = path.join(serverDir, 'server-icon.png');

  if (fs.existsSync(iconPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.sendFile(iconPath);
  } else {
    return res.status(404).json({ error: 'Server icon not found' });
  }
});

// POST /api/v1/servers/:serverId/icon
router.post('/:serverId/icon', async (req: Request, res: Response) => {
  try {
    const { serverId } = req.params;
    console.log(`[Daemon API] Receiving server icon upload for serverId '${serverId}'...`);

    const serverDir = path.join(config.dataDir, serverId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const iconPath = path.join(serverDir, 'server-icon.png');
    const writeStream = fs.createWriteStream(iconPath);
    req.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    try {
      execSync(`chown 1000:1000 "${iconPath}"`);
      execSync(`chmod 664 "${iconPath}"`);
    } catch (e) {}

    const containerName = `mc-server-${serverId}`;
    try {
      await syncServerDirToContainer(containerName, serverId);
    } catch (syncErr: any) {}

    console.log(`[Daemon API] Server icon updated for '${serverId}'`);
    res.json({ message: 'Server icon uploaded successfully', serverId });
  } catch (err: any) {
    console.error(`[Daemon API Error] Upload icon failed:`, err.message);
    res.status(500).json({ error: 'Failed to upload server icon', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/start
router.post('/:containerId/start', async (req: Request, res: Response) => {
  try {
    const { containerId } = req.params;
    console.log('[Daemon API] Starting server container/process:', containerId);

    if (containerId.startsWith('process-')) {
      const serverId = containerId.replace('process-', '');
      const serverDir = path.join(config.dataDir, serverId);
      const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
      
      let dto: CreateServerContainerDto = {
        serverId,
        serverType: 'FABRIC' as any,
        mcVersion: '26.2',
        serverPort: 25565,
        memoryMb: 4096,
        cpuLimit: 1,
        eulaAccepted: true,
        executionMode: ExecutionMode.PROCESS,
      };

      if (fs.existsSync(metaPath)) {
        try {
          const savedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          dto = { ...dto, ...savedMeta, serverId };
        } catch (e) {}
      }

      // Merge incoming metadata from Web API (database source of truth)
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        dto = { ...dto, ...req.body, serverId };
        try {
          fs.writeFileSync(metaPath, JSON.stringify(dto, null, 2));
        } catch (e) {}
      }

      await processManager.startProcess(dto);
      return res.json({ message: 'Standalone server process started successfully' });
    }

    await startServerContainer(containerId);
    res.json({ message: 'Server started successfully' });
  } catch (err: any) {
    console.error('[Daemon API Error] Start failed:', err.message);
    res.status(500).json({ error: 'Failed to start server', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/stop
router.post('/:containerId/stop', async (req: Request, res: Response) => {
  try {
    const { containerId } = req.params;
    const { countdown } = req.query;
    console.log('[Daemon API] Stopping server container/process:', containerId);

    if (containerId.startsWith('process-')) {
      const serverId = containerId.replace('process-', '');
      await processManager.stopProcess(serverId);
      return res.json({ message: 'Standalone server process stopped' });
    }
    
    if (countdown && !isNaN(Number(countdown))) {
      const seconds = Number(countdown);
      // Run it asynchronously so the HTTP request completes immediately
      gracefulStopWithCountdown(containerId, seconds).catch(err => {
        console.error(`[Daemon API Error] Graceful stop failed:`, err.message);
      });
      res.json({ message: `Server stopping gracefully with ${seconds}s countdown` });
    } else {
      await stopServerContainer(containerId);
      res.json({ message: 'Server stopped' });
    }
  } catch (err: any) {
    console.error('[Daemon API Error] Stop failed:', err.message);
    res.status(500).json({ error: 'Failed to stop server', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/restart
router.post('/:containerId/restart', async (req: Request, res: Response) => {
  try {
    const { containerId } = req.params;
    console.log('[Daemon API] Restarting server container/process:', containerId);

    if (containerId.startsWith('process-')) {
      const serverId = containerId.replace('process-', '');
      await processManager.stopProcess(serverId);

      // Read saved metadata so we restart with the correct port, version, type, etc.
      const serverDir = path.join(config.dataDir, serverId);
      const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
      let meta: any = {};
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
      }

      await processManager.startProcess({
        serverId,
        serverType: meta.serverType || 'FABRIC' as any,
        mcVersion: meta.installedVersion || meta.mcVersion || '1.20.1',
        serverPort: meta.serverPort || 25565,
        memoryMb: meta.memoryMb || 2048,
        cpuLimit: meta.cpuLimit || 1,
        eulaAccepted: true,
        executionMode: ExecutionMode.PROCESS,
      });
      return res.json({ message: 'Standalone server process restarted' });
    }

    await restartServerContainer(containerId);
    res.json({ message: 'Server restarted' });
  } catch (err: any) {
    console.error('[Daemon API Error] Restart failed:', err.message);
    res.status(500).json({ error: 'Failed to restart server', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/kill
router.post('/:containerId/kill', async (req: Request, res: Response) => {
  try {
    const { containerId } = req.params;
    console.log('[Daemon API] Killing server container/process:', containerId);

    if (containerId.startsWith('process-')) {
      const serverId = containerId.replace('process-', '');
      await processManager.killProcess(serverId);
      return res.json({ message: 'Standalone server process force killed' });
    }

    await killServerContainer(containerId);
    res.json({ message: 'Server force killed' });
  } catch (err: any) {
    console.error('[Daemon API Error] Kill failed:', err.message);
    res.status(500).json({ error: 'Failed to kill server', details: err.message });
  }
});

// DELETE /api/v1/servers/:containerId
router.delete('/:containerId', async (req: Request, res: Response) => {
  try {
    const { containerId } = req.params;
    const { deleteData, serverId } = req.body;
    console.log('[Daemon API] Deleting server container/process:', containerId);

    if (containerId.startsWith('process-')) {
      const targetServerId = serverId || containerId.replace('process-', '');
      await processManager.killProcess(targetServerId);
      if (deleteData && targetServerId) {
        const serverDir = path.join(config.dataDir, targetServerId);
        if (fs.existsSync(serverDir)) {
          fs.rmSync(serverDir, { recursive: true, force: true });
        }
      }
      return res.json({ message: 'Standalone server process removed' });
    }

    await removeServerContainer(containerId, deleteData, serverId);
    res.json({ message: 'Server container removed' });
  } catch (err: any) {
    console.error('[Daemon API Error] Delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove server', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/export
router.get('/:serverId/export', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const serverDir = path.join(config.dataDir, serverId);

  if (!fs.existsSync(serverDir)) {
    return res.status(404).json({ error: 'Server directory not found' });
  }

  // Sync latest live container data to host directory before exporting
  try {
    await syncContainerToHost(serverId);
  } catch (syncErr: any) {
    console.warn(`[Daemon API Export Sync Warning] ${syncErr.message}`);
  }

  console.log(`[Daemon API] Streaming export for server ${serverId}...`);

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${serverId}.tar.gz"`);

  // tar -czf - -C /path/to/server .
  const tar = spawn('tar', ['-czf', '-', '-C', serverDir, '.']);

  tar.stdout.pipe(res);

  tar.stderr.on('data', (data) => {
    console.warn(`[tar export stderr] ${data}`);
  });

  tar.on('close', (code) => {
    if (code !== 0) {
      console.error(`[Daemon API] tar export failed with code ${code}`);
      if (!res.headersSent) {
        res.status(500).json({ error: `Export failed with code ${code}` });
      } else {
        res.end(); // Attempt to cleanly end the stream
      }
    } else {
      console.log(`[Daemon API] Export complete for ${serverId}`);
    }
  });
});

// POST /api/v1/servers/import?serverId=xyz
router.post('/import', (req: Request, res: Response) => {
  const { serverId } = req.query;
  if (!serverId || typeof serverId !== 'string') {
    return res.status(400).json({ error: 'Missing serverId query parameter' });
  }

  const serverDir = path.join(config.dataDir, serverId);
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }

  console.log(`[Daemon API] Receiving import stream for server ${serverId}...`);

  // tar -xzf - -C /path/to/server
  const tar = spawn('tar', ['-xzf', '-', '-C', serverDir]);

  req.pipe(tar.stdin);

  tar.stderr.on('data', (data) => {
    console.warn(`[tar import stderr] ${data}`);
  });

  tar.on('close', async (code) => {
    if (code !== 0) {
      console.error(`[Daemon API] tar import failed with code ${code}`);
      return res.status(500).json({ error: `Import failed with code ${code}` });
    }

    console.log(`[Daemon API] Import complete for ${serverId}. Proceeding to create container...`);
    
    // We expect the original CreateServerContainerDto to be passed in a header because the body is the stream
    const dtoHeader = req.headers['x-create-dto'];
    if (dtoHeader && typeof dtoHeader === 'string') {
      try {
        const dto: CreateServerContainerDto = JSON.parse(dtoHeader);
        
        // Immediately respond 202, build container asynchronously
        res.status(202).json({ message: 'Import successful, creating container...', serverId });
        
        provisioningManager.run(dto.serverId, async () => {
          const containerId = await createServerContainer(dto);
          // Do NOT automatically start it here so the user can review it first, or we can start it?
          // Web Panel will manage the start if it wants.
          console.log(`[Daemon] Migration container ${containerId} created successfully.`);
        }).catch((err) => {
          console.error(`[Daemon Migration Failed] ${dto.serverId}:`, err.message);
        });

      } catch (err: any) {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to create container post-import', details: err.message });
      }
    } else {
      if (!res.headersSent) res.status(200).json({ message: 'Import successful, but no DTO provided to create container.' });
    }
  });
});

// Helper for safe path resolution preventing directory traversal
function getSafeServerPath(serverId: string, subPath: string = ''): string | null {
  const baseDir = path.resolve(config.dataDir, serverId);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const targetPath = path.resolve(baseDir, subPath ? subPath.replace(/^\//, '') : '');
  if (!targetPath.startsWith(baseDir)) {
    return null;
  }
  return targetPath;
}

// GET /api/v1/servers/:serverId/files/list?path=...
router.get('/:serverId/files/list', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const relPath = (req.query.path as string) || '';

  const targetPath = getSafeServerPath(serverId, relPath);
  if (!targetPath) {
    return res.status(403).json({ error: 'Access denied: Invalid or out-of-bounds path' });
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  try {
    const baseDir = path.resolve(config.dataDir, serverId);
    if (relPath === '' && fs.readdirSync(baseDir).length === 0) {
      await syncContainerToHost(serverId);
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const items = fs.readdirSync(targetPath);
    const files = items.map((name) => {
      const itemPath = path.join(targetPath, name);
      let isDir = false;
      let size = 0;
      let mtime = new Date();

      try {
        const s = fs.statSync(itemPath);
        isDir = s.isDirectory();
        size = s.size;
        mtime = s.mtime;
      } catch (e) {}

      return {
        name,
        path: path.join(relPath, name).replace(/\\/g, '/'),
        isDir,
        size,
        modifiedAt: mtime.toISOString(),
      };
    });

    // Sort directories first, then alphabetical
    files.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ currentPath: relPath, files });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list directory contents', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/files/read?path=...
router.get('/:serverId/files/read', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const relPath = req.query.path as string;

  if (!relPath) return res.status(400).json({ error: 'Missing path parameter' });

  const targetPath = getSafeServerPath(serverId, relPath);
  if (!targetPath) {
    return res.status(403).json({ error: 'Access denied: Invalid path' });
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory as file' });
    }

    if (stats.size > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large to edit directly (> 5MB)' });
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    res.json({ path: relPath, content, size: stats.size, modifiedAt: stats.mtime.toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read file', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/files/write
router.post('/:serverId/files/write', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const { path: relPath, content } = req.body;

  if (!relPath || content === undefined) {
    return res.status(400).json({ error: 'Missing path or content body' });
  }

  const targetPath = getSafeServerPath(serverId, relPath);
  if (!targetPath) {
    return res.status(403).json({ error: 'Access denied: Invalid path' });
  }

  try {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(targetPath, content, 'utf8');
    res.json({ success: true, path: relPath });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to write file', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/files/create-folder
router.post('/:serverId/files/create-folder', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const { path: relPath, name } = req.body;

  if (!name) return res.status(400).json({ error: 'Missing folder name' });

  const targetDir = getSafeServerPath(serverId, path.join(relPath || '', name));
  if (!targetDir) {
    return res.status(403).json({ error: 'Access denied: Invalid folder path' });
  }

  try {
    if (fs.existsSync(targetDir)) {
      return res.status(409).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, folderPath: path.join(relPath || '', name).replace(/\\/g, '/') });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create folder', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/files/rename
router.post('/:serverId/files/rename', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const { oldPath, newPath } = req.body;

  if (!oldPath || !newPath) return res.status(400).json({ error: 'Missing oldPath or newPath' });

  const targetOld = getSafeServerPath(serverId, oldPath);
  const targetNew = getSafeServerPath(serverId, newPath);

  if (!targetOld || !targetNew) {
    return res.status(403).json({ error: 'Access denied: Invalid path' });
  }

  if (!fs.existsSync(targetOld)) {
    return res.status(404).json({ error: 'Source file or folder not found' });
  }

  try {
    fs.renameSync(targetOld, targetNew);
    res.json({ success: true, oldPath, newPath });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to rename', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/files/delete
router.post('/:serverId/files/delete', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const { path: relPath } = req.body;

  if (!relPath) return res.status(400).json({ error: 'Missing path to delete' });

  const targetPath = getSafeServerPath(serverId, relPath);
  if (!targetPath) {
    return res.status(403).json({ error: 'Access denied: Invalid path' });
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File or folder not found' });
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    res.json({ success: true, path: relPath });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete file or directory', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/players
router.get('/:serverId/players', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const players = processManager.getOnlinePlayers(targetId);
  res.json({ players, count: players.length });
});

// POST /api/v1/servers/:serverId/players/action
router.post('/:serverId/players/action', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { username, action, reason } = req.body;

  if (!username || !action) {
    return res.status(400).json({ error: 'Missing username or action' });
  }

  let cmd = '';
  if (action === 'op') cmd = `op ${username}`;
  else if (action === 'deop') cmd = `deop ${username}`;
  else if (action === 'kick') cmd = `kick ${username} ${reason || 'Kicked by administrator'}`;
  else if (action === 'ban') cmd = `ban ${username} ${reason || 'Banned by administrator'}`;
  else return res.status(400).json({ error: `Unsupported player action '${action}'` });

  const success = processManager.writeStdin(targetId, cmd);
  res.json({ success, message: `Dispatched command: ${cmd}` });
});

// GET /api/v1/servers/:serverId/properties
router.get('/:serverId/properties', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const propsPath = getSafeServerPath(targetId, 'server.properties');

  if (!propsPath || !fs.existsSync(propsPath)) {
    return res.json({ properties: {} });
  }

  try {
    const raw = fs.readFileSync(propsPath, 'utf8');
    const properties: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      properties[key] = val;
    }
    res.json({ properties });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read server.properties', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/properties
router.post('/:serverId/properties', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { properties } = req.body;

  if (!properties || typeof properties !== 'object') {
    return res.status(400).json({ error: 'Invalid properties payload' });
  }

  const propsPath = getSafeServerPath(targetId, 'server.properties');
  if (!propsPath) return res.status(403).json({ error: 'Access denied' });

  try {
    let lines: string[] = [];
    if (fs.existsSync(propsPath)) {
      lines = fs.readFileSync(propsPath, 'utf8').split(/\r?\n/);
    }

    const updatedKeys = new Set<string>();
    const newLines = lines.map((line) => {
      if (line.trim().startsWith('#') || !line.includes('=')) return line;
      const idx = line.indexOf('=');
      const key = line.substring(0, idx).trim();
      if (key in properties) {
        updatedKeys.add(key);
        return `${key}=${properties[key]}`;
      }
      return line;
    });

    for (const [k, v] of Object.entries(properties)) {
      if (!updatedKeys.has(k)) {
        newLines.push(`${k}=${v}`);
      }
    }

    fs.writeFileSync(propsPath, newLines.join('\n'), 'utf8');
    res.json({ success: true, message: 'Updated server.properties successfully' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update server.properties', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/stats
router.get('/:serverId/stats', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const stats = processManager.getProcessStats(targetId);
  res.json(stats);
});

// GET /api/v1/servers/:serverId/backups
router.get('/:serverId/backups', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const backups = backupManager.listBackups(targetId);
  res.json({ backups });
});

// POST /api/v1/servers/:serverId/backups
router.post('/:serverId/backups', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { name } = req.body;

  try {
    const isDocker = !serverId.startsWith('process-');
    const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${targetId}`) : serverId;

    // Send save-all to flush in-memory inventories to disk & sync volume files to host
    if (isDocker) {
      try {
        const container = await getContainerByIdOrName(containerId);
        const exec = await container.exec({ Cmd: ['rcli', 'save-all'], AttachStdin: false, AttachStdout: false });
        await exec.start({});
      } catch (e) {}
      try {
        console.log(`[Backups] Syncing live container volume data to host for '${targetId}'...`);
        await syncContainerToHost(targetId);
      } catch (syncErr: any) {
        console.warn(`[Backups] Pre-backup sync warning:`, syncErr.message);
      }
    } else {
      if (processManager.isRunning(targetId)) {
        processManager.writeStdin(targetId, 'save-all');
      }
    }

    const backup = await backupManager.createBackup(targetId, name);
    res.json({ success: true, backup });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create backup', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/backups/restore
router.post('/:serverId/backups/restore', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { name } = req.body;

  if (!name) return res.status(400).json({ error: 'Missing backup name' });

  try {
    const isDocker = !serverId.startsWith('process-');
    const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${targetId}`) : serverId;

    let wasRunning = false;
    if (isDocker) {
      try {
        const inspect = execSync(`docker inspect -f '{{.State.Running}}' ${containerId} 2>/dev/null`).toString().trim();
        wasRunning = inspect === 'true';
        if (wasRunning) {
          await stopServerContainer(containerId);
        }
      } catch (e) {}
    } else {
      wasRunning = processManager.isRunning(targetId);
      if (wasRunning) {
        await processManager.stopProcess(targetId);
      }
    }

    await backupManager.restoreBackup(targetId, name);

    // Fix host permissions for UID 1000 (Minecraft container user)
    const serverDir = path.join(config.dataDir, targetId);
    try {
      execSync(`chown -R 1000:1000 "${serverDir}"`);
      execSync(`chmod -R 775 "${serverDir}"`);
    } catch (e) {}

    // In Docker mode, wipe stale container volume data and sync restored files into volume mc_data_${targetId}
    if (isDocker) {
      try {
        console.log(`[Backups] Cleaning container volume before restoring backup for ${containerId}...`);
        execSync(`docker run --rm -v "mc_data_${targetId}:/data" alpine rm -rf /data/world /data/world_nether /data/world_the_end /data/mods /data/config /data/level.dat /data/level.dat_old`, { stdio: 'ignore' });
        console.log(`[Backups] Syncing restored backup files into Docker volume for ${containerId}...`);
        await syncServerDirToContainer(containerId, targetId);
      } catch (syncErr: any) {
        console.error(`[Backups] Warning: Volume sync after restore failed:`, syncErr.message);
      }
    }

    if (wasRunning) {
      console.log(`[Backups] Automatically restarting server ${containerId} after restore...`);
      if (isDocker) {
        await startServerContainer(containerId).catch((err) => {
          console.error(`[Backups] Failed to restart container ${containerId}:`, err);
        });
      } else {
        const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
        let dto: any = { serverId: targetId, mcVersion: '26.2', serverType: 'FABRIC', serverPort: 25565, memoryMb: 4096, eulaAccepted: true, executionMode: ExecutionMode.PROCESS };
        if (fs.existsSync(metaPath)) {
          try { dto = { ...dto, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (e) {}
        }
        await processManager.startProcess(dto).catch((err) => {
          console.error(`[Backups] Failed to restart process ${targetId}:`, err);
        });
      }
    }

    res.json({
      success: true,
      message: wasRunning
        ? 'Backup restored & server restarted successfully!'
        : 'Backup restored successfully! Click Start to launch your server.',
    });
  } catch (err: any) {
    console.error(`[Backups] Failed to restore backup:`, err.message);
    res.status(500).json({ error: 'Failed to restore backup', details: err.message });
  }
});

// DELETE /api/v1/servers/:serverId/backups/:name
router.delete('/:serverId/backups/:name', (req: Request, res: Response) => {
  const { serverId, name } = req.params;
  const targetId = serverId.replace('process-', '');

  try {
    backupManager.deleteBackup(targetId, name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete backup', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/subdomain
router.post('/:serverId/subdomain', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { subdomain, domain, port } = req.body;

  const serverDir = path.join(loadConfig().dataDir, targetId);
  const metaPath = path.join(serverDir, 'craftcontrol-meta.json');

  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.subdomain = subdomain;
      meta.domain = domain;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (e) {}
  }

  console.log(`[ProxyRouter] Configured subdomain route for server ${targetId}: ${subdomain}.${domain} -> port ${port}`);
  res.json({ success: true, subdomain, domain });
});

// POST /api/v1/servers/:serverId/update-engine
router.post('/:serverId/update-engine', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { serverType, mcVersion, createBackup } = req.body;

  if (!serverType || !mcVersion) {
    return res.status(400).json({ error: 'Missing serverType or mcVersion' });
  }

  try {
    const isDocker = !serverId.startsWith('process-');
    const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${targetId}`) : serverId;

    // 1. Pre-update safety snapshot
    if (createBackup) {
      console.log(`[UpdateEngine] Creating pre-update safety backup for '${targetId}'...`);
      if (isDocker) {
        try { await syncContainerToHost(targetId); } catch (e) {}
      }
      await backupManager.createBackup(targetId, `pre_update_${serverType.toLowerCase()}_${mcVersion}`);
    }

    // 2. Stop running server instance
    let wasRunning = false;
    if (isDocker) {
      try {
        const inspect = execSync(`docker inspect -f '{{.State.Running}}' ${containerId} 2>/dev/null`).toString().trim();
        wasRunning = inspect === 'true';
        if (wasRunning) {
          await stopServerContainer(containerId);
        }
      } catch (e) {}
    } else {
      wasRunning = processManager.isRunning(targetId);
      if (wasRunning) {
        await processManager.stopProcess(targetId);
      }
    }

    // 3. Clear old server executable JARs so the new loader JAR will be downloaded fresh
    const serverDir = path.join(config.dataDir, targetId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const filesToRemove = ['server.jar', 'fabric-server-launch.jar', 'user_args.txt', 'unix_args.txt'];
    for (const f of filesToRemove) {
      const fPath = path.join(serverDir, f);
      if (fs.existsSync(fPath)) {
        try { fs.rmSync(fPath, { force: true }); } catch (e) {}
      }
    }

    // 4. Update craftcontrol-meta.json
    const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
    let meta: any = { serverId: targetId, serverType, mcVersion, installedVersion: mcVersion };
    if (fs.existsSync(metaPath)) {
      try {
        meta = { ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), ...meta };
      } catch (e) {}
    }
    meta.serverType = serverType;
    meta.mcVersion = mcVersion;
    meta.installedVersion = mcVersion;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // 5. Download the new engine executable
    const dto: any = {
      serverId: targetId,
      serverType,
      mcVersion,
      serverPort: meta.serverPort || 25565,
      memoryMb: meta.memoryMb || 4096,
      eulaAccepted: true,
      executionMode: isDocker ? ExecutionMode.CONTAINER : ExecutionMode.PROCESS,
      forceRedownload: true,
    };

    console.log(`[UpdateEngine] Downloading fresh ${serverType} JAR for ${mcVersion}...`);
    await processManager.ensureServerJar(serverDir, dto);

    // 6. In Docker mode, recreate container with the appropriate Java image if Java version changed, or sync volume
    if (isDocker) {
      try {
        const imageTag = getItzgImageTag(mcVersion);
        console.log(`[UpdateEngine] Target Docker image tag for ${mcVersion}: ${imageTag}`);
        await ensureDockerImage(imageTag);
        await syncServerDirToContainer(containerId, targetId);
      } catch (dockerErr: any) {
        console.warn(`[UpdateEngine Warning] Container volume sync:`, dockerErr.message);
      }
    }

    // Fix host directory permissions for UID 1000
    try {
      execSync(`chown -R 1000:1000 "${serverDir}"`);
      execSync(`chmod -R 775 "${serverDir}"`);
    } catch (e) {}

    // 7. Restart server if it was previously running
    if (wasRunning) {
      console.log(`[UpdateEngine] Restarting server '${containerId}' with updated engine...`);
      if (isDocker) {
        await startServerContainer(containerId).catch((err) => {
          console.error(`[UpdateEngine] Failed to restart container:`, err);
        });
      } else {
        await processManager.startProcess(dto).catch((err) => {
          console.error(`[UpdateEngine] Failed to restart process:`, err);
        });
      }
    }

    res.json({
      success: true,
      message: `Server engine updated successfully to ${serverType} (${mcVersion})!`,
    });
  } catch (err: any) {
    console.error(`[UpdateEngine Error]`, err.message);
    res.status(500).json({ error: 'Failed to update server engine', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/repair-world
router.post('/:serverId/repair-world', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');

  try {
    const isDocker = !serverId.startsWith('process-');
    const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${targetId}`) : serverId;

    // 1. Stop running server instance
    let wasRunning = false;
    if (isDocker) {
      try {
        const inspect = execSync(`docker inspect -f '{{.State.Running}}' ${containerId} 2>/dev/null`).toString().trim();
        wasRunning = inspect === 'true';
        if (wasRunning) {
          await stopServerContainer(containerId);
        }
      } catch (e) {}
    } else {
      wasRunning = processManager.isRunning(targetId);
      if (wasRunning) {
        await processManager.stopProcess(targetId);
      }
    }

    const serverDir = path.join(config.dataDir, targetId);
    const worldDir = path.join(serverDir, 'world');
    const levelDat = path.join(worldDir, 'level.dat');
    const levelDatOld = path.join(worldDir, 'level.dat_old');

    let repairedMethod = '';

    if (fs.existsSync(worldDir)) {
      // 1. Backup all level headers on host
      if (fs.existsSync(levelDat)) {
        try { fs.copyFileSync(levelDat, path.join(worldDir, 'level.dat.corrupt')); } catch (e) {}
        try { fs.rmSync(levelDat, { force: true }); } catch (e) {}
      }
      if (fs.existsSync(levelDatOld)) {
        try { fs.copyFileSync(levelDatOld, path.join(worldDir, 'level.dat_old.corrupt')); } catch (e) {}
        try { fs.rmSync(levelDatOld, { force: true }); } catch (e) {}
      }

      // 2. Disable incompatible datapacks if present
      const datapacksDir = path.join(worldDir, 'datapacks');
      if (fs.existsSync(datapacksDir)) {
        try {
          const dpBackup = path.join(worldDir, 'datapacks_disabled');
          if (fs.existsSync(dpBackup)) fs.rmSync(dpBackup, { recursive: true, force: true });
          fs.renameSync(datapacksDir, dpBackup);
          fs.mkdirSync(datapacksDir, { recursive: true });
        } catch (e) {}
      }

      // 3. Remove legacy './world/players' directory causing conversion exception
      const oldPlayersDir = path.join(worldDir, 'players');
      if (fs.existsSync(oldPlayersDir)) {
        try { fs.rmSync(oldPlayersDir, { recursive: true, force: true }); } catch (e) {}
      }

      repairedMethod = 'Purged invalid level.dat headers, removed legacy ./world/players, & disabled incompatible datapacks';
    } else {
      return res.status(400).json({ error: 'No world directory found for this server' });
    }

    // 4. WIPE stale level.dat / datapacks / legacy players directly inside Docker volume before sync
    if (isDocker) {
      try {
        console.log(`[RepairWorld] Purging level.dat & legacy players inside Docker volume mc_data_${targetId}...`);
        execSync(`docker run --rm -v "mc_data_${targetId}:/data" alpine rm -rf /data/world/level.dat /data/world/level.dat_old /data/world/datapacks /data/world/players`, { stdio: 'ignore' });
      } catch (e) {}
    }

    // Fix host directory permissions for UID 1000
    try {
      execSync(`chown -R 1000:1000 "${serverDir}"`);
      execSync(`chmod -R 775 "${serverDir}"`);
    } catch (e) {}

    // Sync repaired files to container volume if in Docker mode
    if (isDocker) {
      try {
        await syncServerDirToContainer(containerId, targetId);
      } catch (e) {}
    }

    // Restart server if it was previously running
    if (wasRunning) {
      if (isDocker) {
        await startServerContainer(containerId).catch((err) => {
          console.error(`[RepairWorld] Failed to restart container:`, err);
        });
      } else {
        const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
        let dto: any = { serverId: targetId, mcVersion: '26.2', serverType: 'FABRIC', serverPort: 25565, memoryMb: 4096, eulaAccepted: true, executionMode: ExecutionMode.CONTAINER };
        if (fs.existsSync(metaPath)) {
          try { dto = { ...dto, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (e) {}
        }
        await processManager.startProcess(dto).catch((err) => {
          console.error(`[RepairWorld] Failed to restart process:`, err);
        });
      }
    }

    res.json({
      success: true,
      message: `World repair complete: ${repairedMethod}. Server ready!`,
    });
  } catch (err: any) {
    console.error(`[RepairWorld Error]`, err.message);
    res.status(500).json({ error: 'Failed to repair world settings', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SCHEDULE & CRON MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────────────

// GET /api/v1/servers/:serverId/schedules
router.get('/:serverId/schedules', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  try {
    const schedules = await prisma.serverSchedule.findMany({
      where: { serverId: targetId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ schedules });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch schedules', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/schedules
router.post('/:serverId/schedules', async (req: Request, res: Response) => {
  const { serverId } = req.params;
  const targetId = serverId.replace('process-', '');
  const { name, cronExpression, actionType, payload, isEnabled } = req.body;

  if (!name || !cronExpression || !actionType) {
    return res.status(400).json({ error: 'Missing required schedule fields (name, cronExpression, actionType)' });
  }

  try {
    const schedule = await prisma.serverSchedule.create({
      data: {
        serverId: targetId,
        name,
        cronExpression,
        actionType,
        payload: payload || null,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
      },
    });
    res.json({ success: true, schedule });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create schedule', details: err.message });
  }
});

// PUT /api/v1/servers/:serverId/schedules/:scheduleId
router.put('/:serverId/schedules/:scheduleId', async (req: Request, res: Response) => {
  const { scheduleId } = req.params;
  const { name, cronExpression, actionType, payload, isEnabled } = req.body;

  try {
    const schedule = await prisma.serverSchedule.update({
      where: { id: scheduleId },
      data: {
        ...(name && { name }),
        ...(cronExpression && { cronExpression }),
        ...(actionType && { actionType }),
        ...(payload !== undefined && { payload }),
        ...(isEnabled !== undefined ? { isEnabled: Boolean(isEnabled) } : {}),
      },
    });
    res.json({ success: true, schedule });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update schedule', details: err.message });
  }
});

// DELETE /api/v1/servers/:serverId/schedules/:scheduleId
router.delete('/:serverId/schedules/:scheduleId', async (req: Request, res: Response) => {
  const { scheduleId } = req.params;

  try {
    await prisma.serverSchedule.delete({
      where: { id: scheduleId },
    });
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete schedule', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/schedules/:scheduleId/trigger
router.post('/:serverId/schedules/:scheduleId/trigger', async (req: Request, res: Response) => {
  const { scheduleId } = req.params;

  try {
    const schedule = await prisma.serverSchedule.findUnique({
      where: { id: scheduleId },
      include: { server: true },
    });

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const { schedulerService } = require('../services/scheduler');
    await schedulerService.executeSchedule(schedule);

    res.json({ success: true, message: `Schedule '${schedule.name}' executed manually!` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to trigger schedule', details: err.message });
  }
});

export default router;
