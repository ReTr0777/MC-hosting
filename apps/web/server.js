const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const httpProxy = require('http-proxy');
const { PrismaClient } = require('@prisma/client');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({ ws: true });
const prisma = new PrismaClient();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const parsedUrl = parse(req.url, true);
      
      if (parsedUrl.pathname === '/api/ws/console') {
        const { serverId, containerId } = parsedUrl.query;
        
        if (!serverId || !containerId) {
          console.error('[WS Proxy] Missing serverId or containerId');
          socket.destroy();
          return;
        }

        const mcServer = await prisma.server.findUnique({
          where: { id: serverId },
          include: { node: true }
        });

        if (!mcServer || !mcServer.node) {
          console.error(`[WS Proxy] Server or Node not found for serverId: ${serverId}`);
          socket.destroy();
          return;
        }

        const node = mcServer.node;

        // Clean headers to prevent HTTP 400 Bad Request from invalid HTTP/2 pseudo-headers
        const wsHeaders = {
          host: `${node.host}:${node.port}`,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': req.headers['sec-websocket-key'],
          'sec-websocket-version': req.headers['sec-websocket-version'],
          authorization: `Bearer ${node.apiKey}`
        };
        if (req.headers['sec-websocket-extensions']) {
          wsHeaders['sec-websocket-extensions'] = req.headers['sec-websocket-extensions'];
        }
        if (req.headers['sec-websocket-protocol']) {
          wsHeaders['sec-websocket-protocol'] = req.headers['sec-websocket-protocol'];
        }

        const options = {
          hostname: node.host,
          port: node.port,
          path: `/api/v1/servers/${serverId}/console?containerId=${containerId}`,
          method: 'GET',
          headers: wsHeaders
        };

        console.log(`[WS Proxy] Proxying console for ${serverId} to ws://${node.host}:${node.port}${options.path}`);

        const proxyReq = require('http').request(options);
        
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          let headers = `HTTP/${req.httpVersion} 101 Switching Protocols\r\n`;
          for (const key in proxyRes.headers) {
            headers += `${key}: ${proxyRes.headers[key]}\r\n`;
          }
          headers += '\r\n';
          
          socket.write(headers);
          if (proxyHead && proxyHead.length) {
            socket.write(proxyHead);
          }
          
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });

        proxyReq.on('error', (err) => {
          console.error('[WS Proxy] Error connecting to daemon:', err);
          socket.destroy();
        });

        // Handle unexpected HTTP response (e.g. 404 Not Found)
        proxyReq.on('response', (proxyRes) => {
          console.error(`[WS Proxy] Daemon rejected upgrade with status: ${proxyRes.statusCode}`);
          socket.destroy();
        });

        proxyReq.end();
      } else {
        // Delegate to Next.js for HMR and other web sockets
        if (app.getUpgradeHandler) {
          app.getUpgradeHandler()(req, socket, head);
        }
      }
    } catch (err) {
      console.error('WebSocket proxy error:', err);
      socket.destroy();
    }
  });

  proxy.on('error', (err, req, socket) => {
    console.error('[WS Proxy] Proxy Error:', err);
    if (socket && socket.destroy) {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket proxy ready for /api/ws/console`);
  });
});
