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

const crypto = require('crypto');

function acceptAndCloseWS(req, socket, reason) {
  try {
    const key = req.headers['sec-websocket-key'];
    if (key) {
      const acceptKey = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      
      const response = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
      ].join('\r\n');
      socket.write(response);

      const reasonBuf = Buffer.from(reason || 'Server not found');
      const frame = Buffer.alloc(2 + reasonBuf.length + 2);
      frame[0] = 0x88; // FIN bit set, opcode 0x8 (Close)
      frame[1] = 2 + reasonBuf.length;
      frame.writeUInt16BE(1008, 2);
      reasonBuf.copy(frame, 4);
      socket.write(frame);
    }
  } catch (e) {}
  setTimeout(() => {
    try { socket.end(); } catch (e) {}
  }, 100);
}

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
        
        if (!serverId) {
          console.error('[WS Proxy] Missing serverId');
          acceptAndCloseWS(req, socket, 'Missing serverId');
          return;
        }

        const mcServer = await prisma.server.findUnique({
          where: { id: serverId },
          include: { node: true }
        });

        if (!mcServer || !mcServer.node) {
          console.error(`[WS Proxy] Server or Node not found for serverId: ${serverId}`);
          acceptAndCloseWS(req, socket, 'Server or Node not found');
          return;
        }

        const node = mcServer.node;
        const targetContainer = containerId || mcServer.containerId || serverId;

        let targetHost = node.host;
        let targetPort = node.port || 3001;

        if (targetHost && targetHost.includes(':')) {
          const parts = targetHost.split(':');
          targetHost = parts[0];
          targetPort = parseInt(parts[1], 10) || targetPort;
        }

        let hasRetried = false;

        const attemptProxy = (host, port) => {
          const wsHeaders = {
            host: `${host}:${port}`,
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
            hostname: host,
            port: port,
            path: `/api/v1/servers/${serverId}/console?containerId=${targetContainer}`,
            method: 'GET',
            headers: wsHeaders
          };

          console.log(`[WS Proxy] Proxying console for ${serverId} to ws://${host}:${port}${options.path}`);

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
            console.error(`[WS Proxy] Error connecting to daemon at ${host}:${port}:`, err.message);
            if (!hasRetried) {
              hasRetried = true;
              const altPort = port === 3001 ? 3500 : 3001;
              console.log(`[WS Proxy] Retrying connection to daemon on fallback port ${altPort}...`);
              attemptProxy(host, altPort);
            } else {
              try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch (e) {}
              socket.destroy();
            }
          });

          proxyReq.on('response', (proxyRes) => {
            console.error(`[WS Proxy] Daemon rejected upgrade with status: ${proxyRes.statusCode}`);
            try { socket.write(`HTTP/1.1 ${proxyRes.statusCode || 502} Bad Gateway\r\nConnection: close\r\n\r\n`); } catch (e) {}
            socket.destroy();
          });

          proxyReq.end();
        };

        attemptProxy(targetHost, targetPort);
        return;
      } else {
        // Delegate to Next.js for HMR and other web sockets
        if (app.getUpgradeHandler) {
          app.getUpgradeHandler()(req, socket, head);
        }
      }
    } catch (err) {
      console.error('WebSocket proxy error:', err);
      try { socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch (e) {}
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
