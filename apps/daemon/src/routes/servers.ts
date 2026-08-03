import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import { loadConfig } from '../config';
import {
  createServerContainer,
  startServerContainer,
  stopServerContainer,
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
    console.log('[Daemon API] Stopping server container:', req.params.containerId);
    await stopServerContainer(req.params.containerId);
    res.json({ message: 'Server stop signal dispatched' });
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

export default router;
