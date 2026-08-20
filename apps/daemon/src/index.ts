// First, deliberately: this registers the process-level guards before any other
// module's top-level code runs and gets the chance to fail.
import { installProcessGuards } from './guards';
installProcessGuards();

import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config';
import { authenticateDaemonKey } from './middleware/auth';
import systemRoutes from './routes/system';
import tmodRoutes from './routes/tmods';
import serverRoutes from './routes/servers';
import setupRoutes from './routes/setup';
import { handleConsoleWebSocket } from './services/runtime/console';
import { tunnelManager } from './services/network/frpc';
import { schedulerService } from './services/scheduler';
import { ensureContainerRestartPolicies, docker } from './services/runtime/docker';
import { presenceService } from './services/presence/presence';

// Never awaited, so a rejection here would otherwise be an unhandled one — which Node
// turns into an exit. The tunnel is optional; the node it runs on is not.
tunnelManager.init().catch((err: Error) => {
  console.error(`[TunnelManager] Tunnel setup failed: ${err.message}. The node keeps running without it.`);
});
schedulerService.start();
ensureContainerRestartPolicies().catch(() => {});

// Presence tracking has to survive a daemon restart: containers keep running, and players who
// were online before the restart are still online after it. Re-attach to everything already up.
presenceService.hookProcessManager();
docker
  .listContainers({ filters: { name: ['mc-server-'] } })
  .then((containers) => {
    for (const c of containers) {
      const name = (c.Names?.[0] || '').replace(/^\/?mc-server-/, '');
      if (name) presenceService.trackContainer(name).catch(() => {});
    }
  })
  .catch(() => {});

const config = loadConfig();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));

// Setup GUI routes
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/v1/setup', setupRoutes);

// Public health ping (optional basic ping)
app.get('/ping', (req, res) => res.send('pong'));

// Authenticated REST routes
app.use('/api/v1/system', authenticateDaemonKey, systemRoutes);
// Mounted before serverRoutes so its own :serverId routes are matched first. Express
// tries routers in order, and servers.ts has broad patterns that would otherwise claim
// these paths.
app.use('/api/v1/servers', authenticateDaemonKey, tmodRoutes);
app.use('/api/v1/servers', authenticateDaemonKey, serverRoutes);

// WebSocket upgrade handling for console streaming
server.on('upgrade', (request, socket, head) => {
  console.log(`[Daemon API] Received WebSocket upgrade request for ${request.url}`);
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Path format: /api/v1/servers/:serverId/console?containerId=xxx
  const match = pathname.match(/^\/api\/v1\/servers\/([^\/]+)\/console$/);

  if (match) {
    const serverId = match[1];
    const containerId = url.searchParams.get('containerId') || '';

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      handleConsoleWebSocket(ws, serverId, containerId, request);
    });
  } else {
    socket.destroy();
  }
});

/*
 * The one failure that must stay fatal.
 *
 * Everything else in this process is allowed to fail and carry on, but a node that
 * cannot listen is not a node — and the guards in ./guards would otherwise turn this
 * into a process that stays alive answering nothing, which looks identical to a
 * healthy node from the outside and is far worse than exiting.
 *
 * The literal error code belongs in the message: the desktop app reads stderr for it
 * to tell a port clash apart from a crash.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[Daemon] Port ${config.port} is already in use (EADDRINUSE). Another node agent — or a ` +
        'daemon running in Docker — already has it. Change the port, or stop the other one.'
    );
  } else {
    console.error(`[Daemon] The API server could not start: ${err.code ?? ''} ${err.message}`.trim());
  }
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`====================================================`);
  console.log(`  Minecraft Server Manager Daemon Agent Online       `);
  console.log(`  Port: ${config.port}                                `);
  console.log(`  API Key: ${config.apiKey.substring(0, 4)}***        `);
  console.log(`====================================================`);
});
