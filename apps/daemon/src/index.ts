import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config';
import { authenticateDaemonKey } from './middleware/auth';
import systemRoutes from './routes/system';
import serverRoutes from './routes/servers';
import setupRoutes from './routes/setup';
import { handleConsoleWebSocket } from './services/console';
import { tunnelManager } from './services/frpc';

tunnelManager.init();

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
      handleConsoleWebSocket(ws, serverId, containerId);
    });
  } else {
    socket.destroy();
  }
});

server.listen(config.port, () => {
  console.log(`====================================================`);
  console.log(`  Minecraft Server Manager Daemon Agent Online       `);
  console.log(`  Port: ${config.port}                                `);
  console.log(`  API Key: ${config.apiKey.substring(0, 4)}***        `);
  console.log(`====================================================`);
});
