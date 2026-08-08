import { WebSocket } from 'ws';
import { getContainerByIdOrName } from './docker';
import { processManager } from './process';
import { getConfig } from '../config';
import { WsIncomingMessage, WsOutgoingMessage } from '@mc-manager/shared';
import { provisioningManager } from './provisioning';

export function handleConsoleWebSocket(ws: WebSocket, serverId: string, containerId: string) {
  let authenticated = false;
  let stream: NodeJS.ReadableStream | null = null;
  const config = getConfig();

  // 5-second authentication timeout
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      const errPayload: WsOutgoingMessage = {
        event: 'error',
        message: 'Authentication timeout. Connection closed.',
      };
      ws.send(JSON.stringify(errPayload));
      ws.close(4001, 'Unauthorized Timeout');
    }
  }, 5000);

  ws.on('message', async (rawMessage: string | Buffer) => {
    try {
      const message: WsIncomingMessage = JSON.parse(rawMessage.toString());

      // 1. Initial Handshake Authentication
      if (!authenticated) {
        if (message.auth && message.auth === config.apiKey) {
          authenticated = true;
          clearTimeout(authTimeout);

          const successPayload: WsOutgoingMessage = {
            event: 'authenticated',
            message: 'Daemon WebSocket authenticated successfully.',
          };
          ws.send(JSON.stringify(successPayload));

          const targetContainerRef = containerId || serverId;

          // 2. Replay buffered provisioning logs immediately on connect
          const history = provisioningManager.getLogBuffer(serverId);
          for (const entry of history) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'log', data: `${entry.line}\n`, type: entry.type }));
            }
          }

          // 3. Listen for live provisioning and process log events
          const logListener = (payload: any) => {
            if (payload.serverId === serverId && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'log', data: `${payload.line}\n`, type: payload.type }));
            }
          };
          provisioningManager.on('log', logListener);
          processManager.on('log', logListener);

          ws.on('close', () => {
            provisioningManager.removeListener('log', logListener);
            processManager.removeListener('log', logListener);
          });

          // 4. Attach & Auto-Reattach to Container Stream if running in Docker container mode
          const attachStream = async () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (processManager.isRunning(serverId) || containerId?.startsWith('process-')) {
              // Server is running as a standalone native process managed by processManager
              const mp = processManager.getProcess(serverId);
              if (mp) {
                for (const line of mp.logBuffer) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'log', data: `${line}\n` }));
                  }
                }
              }
              return;
            }

            try {
              const container = await getContainerByIdOrName(targetContainerRef);
              const containerStream = await container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                tail: 150,
              });

              stream = containerStream;

              containerStream.on('data', (chunk: Buffer) => {
                if (ws.readyState === WebSocket.OPEN) {
                  let cleanData = chunk.toString('utf-8');
                  if (chunk.length > 8 && (chunk[0] === 1 || chunk[0] === 2) && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
                    cleanData = chunk.slice(8).toString('utf-8');
                  }

                  const logMessage: WsOutgoingMessage = {
                    event: 'log',
                    data: cleanData,
                  };
                  ws.send(JSON.stringify(logMessage));

                  // Intercept common connection crashes and provide a helpful tip
                  if (cleanData.includes('lost connection: Disconnected') || cleanData.includes('Connection reset by peer')) {
                    if (!Reflect.get(ws, 'kryptonTipSent')) {
                      Reflect.set(ws, 'kryptonTipSent', true);
                      const tip = `\u001b[33m[CraftControl Tip] Did the player immediately get kicked? If their client shows 'VarInt too big' or a Decoder Exception, this is a network mod conflict! The player should delete 'krypton', 'connectivity', or 'canary' from their client's mods folder.\u001b[0m\n`;
                      ws.send(JSON.stringify({ event: 'log', data: tip }));
                      
                      // Reset the tip cooldown after 10 seconds so it doesn't spam
                      setTimeout(() => Reflect.set(ws, 'kryptonTipSent', false), 10000);
                    }
                  }
                }
              });

              containerStream.on('end', () => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ event: 'status', data: 'Server process ended. Re-attaching stream...' }));
                  setTimeout(attachStream, 1500);
                }
              });

              containerStream.on('error', () => {
                if (ws.readyState === WebSocket.OPEN) {
                  setTimeout(attachStream, 2000);
                }
              });
            } catch (err: any) {
              console.warn(`[Daemon Console Warning] Docker stream attach fallback: ${err.message}`);
            }
          };

          await attachStream();
          return;
        } else {
          ws.send(JSON.stringify({ event: 'error', message: 'Invalid API Key' }));
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      // 3. Command execution (write to standalone process stdin or container via rcli exec)
      if (authenticated && message.event === 'command' && message.data) {
        if (processManager.isRunning(serverId) || processManager.getProcess(serverId)) {
          processManager.writeStdin(serverId, message.data);
        } else {
          try {
            const container = await getContainerByIdOrName(serverId);
            const exec = await container.exec({
              Cmd: ['rcli', message.data],
              AttachStdin: false,
              AttachStdout: true,
              AttachStderr: true,
            });
            await exec.start({});
          } catch (e: any) {
            console.warn(`[Daemon Command Exec Error] ${e.message}`);
          }
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ event: 'error', message: 'Malformed JSON payload' }));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (stream) {
      try {
        (stream as any).end();
      } catch (e) {
        // ignore cleanup error
      }
    }
  });
}
