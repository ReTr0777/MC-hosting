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
} from '../services/docker';
import { provisioningManager } from '../services/provisioning';
import { CreateServerContainerDto } from '@mc-manager/shared';

const router = Router();
const config = loadConfig();

// POST /api/v1/servers/create
router.post('/create', async (req: Request, res: Response) => {
  try {
    const dto: CreateServerContainerDto = req.body;
    console.log('[Daemon API] Received container creation request:', JSON.stringify(dto));

    if (!dto.serverId || !dto.serverType || !dto.serverPort) {
      return res.status(400).json({ error: 'Missing required parameters: serverId, serverType, serverPort' });
    }

    if (provisioningManager.isLocked(dto.serverId)) {
      return res.status(409).json({ status: 'PROVISIONING', message: 'Provisioning already in progress' });
    }

    // Immediately respond with HTTP 202 Accepted
    res.status(202).json({ message: 'Server container creation accepted', serverId: dto.serverId, status: 'PROVISIONING' });

    // Execute background build and startup non-blocking
    provisioningManager.run(dto.serverId, async () => {
      const containerId = await createServerContainer(dto);
      await startServerContainer(containerId, dto.serverId);
    }).catch((err) => {
      console.error(`[Daemon Background Build Failed] ${dto.serverId}:`, err.message);
    });
  } catch (err: any) {
    console.error('[Daemon API Error] Container creation failed:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to create server container', details: err.message });
  }
});

// POST /api/v1/servers/:serverId/upload-pack
router.post('/:serverId/upload-pack', async (req: Request, res: Response) => {
  try {
    const { serverId } = req.params;
    console.log(`[Daemon API] Receiving streaming serverpack ZIP upload for serverId '${serverId}'...`);

    const serverDir = path.join(config.dataDir, serverId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const zipPath = path.join(serverDir, 'serverpack.zip');
    
    // Stream directly to disk to prevent RAM exhaustion and event loop blocking
    const writeStream = fs.createWriteStream(zipPath);
    req.pipe(writeStream);
    
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    console.log(`[Daemon API] Serverpack ZIP saved to disk, extracting via native unzip...`);
    
    const { execSync } = require('child_process');
    // Using native unzip is infinitely faster than AdmZip for massive files
    execSync(`unzip -q -o "${zipPath}" -d "${serverDir}"`);
    fs.rmSync(zipPath, { force: true });
    
    // Fix permissions so the itzg/minecraft-server image (which runs as UID 1000) can modify files (like server.properties)
    execSync(`chown -R 1000:1000 "${serverDir}"`);
    execSync(`chmod -R 775 "${serverDir}"`);

    console.log(`[Daemon API] Serverpack ZIP extracted into '${serverDir}'`);

    // Smart Nested Directory Flattening: If ZIP extracted everything into a single subfolder (e.g. serverpack-v1/), move contents to top level
    const items = fs.readdirSync(serverDir);
    if (items.length === 1 && fs.statSync(path.join(serverDir, items[0])).isDirectory()) {
      const subDir = path.join(serverDir, items[0]);
      console.log(`[Daemon ZIP Extractor] Flattening nested root directory '${items[0]}'...`);
      const subItems = fs.readdirSync(subDir);
      for (const subItem of subItems) {
        fs.renameSync(path.join(subDir, subItem), path.join(serverDir, subItem));
      }
      fs.rmdirSync(subDir);
    }

    // Sync extracted serverpack files into container volume via Docker putArchive API
    const containerName = `mc-server-${serverId}`;
    try {
      await syncServerDirToContainer(containerName, serverId);
    } catch (syncErr: any) {
      console.warn(`[Daemon API Sync Warning] ${syncErr.message}`);
    }

    res.json({ message: 'Serverpack ZIP extracted successfully', serverId });
  } catch (err: any) {
    console.error(`[Daemon API Error] Upload pack failed:`, err.message);
    res.status(500).json({ error: 'Failed to extract serverpack ZIP', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/start
router.post('/:containerId/start', async (req: Request, res: Response) => {
  try {
    console.log('[Daemon API] Starting server container:', req.params.containerId);
    await startServerContainer(req.params.containerId);
    res.json({ message: 'Server started successfully' });
  } catch (err: any) {
    console.error('[Daemon API Error] Start failed:', err.message);
    res.status(500).json({ error: 'Failed to start server container', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/stop
router.post('/:containerId/stop', async (req: Request, res: Response) => {
  try {
    const { countdown } = req.query;
    console.log('[Daemon API] Stopping server container:', req.params.containerId);
    
    if (countdown && !isNaN(Number(countdown))) {
      const seconds = Number(countdown);
      // Run it asynchronously so the HTTP request completes immediately
      gracefulStopWithCountdown(req.params.containerId, seconds).catch(err => {
        console.error(`[Daemon API Error] Graceful stop failed:`, err.message);
      });
      res.json({ message: `Server stopping gracefully with ${seconds}s countdown` });
    } else {
      await stopServerContainer(req.params.containerId);
      res.json({ message: 'Server stopped' });
    }
  } catch (err: any) {
    console.error('[Daemon API Error] Stop failed:', err.message);
    res.status(500).json({ error: 'Failed to stop server container', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/restart
router.post('/:containerId/restart', async (req: Request, res: Response) => {
  try {
    console.log('[Daemon API] Restarting server container:', req.params.containerId);
    await restartServerContainer(req.params.containerId);
    res.json({ message: 'Server restarted' });
  } catch (err: any) {
    console.error('[Daemon API Error] Restart failed:', err.message);
    res.status(500).json({ error: 'Failed to restart server container', details: err.message });
  }
});

// POST /api/v1/servers/:containerId/kill
router.post('/:containerId/kill', async (req: Request, res: Response) => {
  try {
    console.log('[Daemon API] Killing server container:', req.params.containerId);
    await killServerContainer(req.params.containerId);
    res.json({ message: 'Server force killed' });
  } catch (err: any) {
    console.error('[Daemon API Error] Kill failed:', err.message);
    res.status(500).json({ error: 'Failed to kill server container', details: err.message });
  }
});

// DELETE /api/v1/servers/:containerId
router.delete('/:containerId', async (req: Request, res: Response) => {
  try {
    const { deleteData, serverId } = req.body;
    console.log('[Daemon API] Deleting server container:', req.params.containerId);
    await removeServerContainer(req.params.containerId, deleteData, serverId);
    res.json({ message: 'Server container removed' });
  } catch (err: any) {
    console.error('[Daemon API Error] Delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove server container', details: err.message });
  }
});

// GET /api/v1/servers/:serverId/export
router.get('/:serverId/export', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const serverDir = path.join(config.dataDir, serverId);

  if (!fs.existsSync(serverDir)) {
    return res.status(404).json({ error: 'Server directory not found' });
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

export default router;
