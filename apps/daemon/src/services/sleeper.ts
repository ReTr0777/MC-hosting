import net from 'net';
import { writeVarInt, readVarInt, frame, parseHandshake } from './mc-ping';
import { startTarget, bareServerId } from './lifecycle';

/**
 * Sleep-on-empty / wake-on-join.
 *
 * While a server is asleep its process is gone, but something still has to answer on its
 * port — otherwise the server just looks dead in the multiplayer list and nobody can ask
 * for it back. This holds that port with a tiny TCP listener that speaks just enough of
 * the Minecraft handshake to do two things:
 *
 *   - status ping (next-state 1): reply with a MOTD saying the server is sleeping, so it
 *     shows up as online with a clear "join to wake" hint
 *   - login (next-state 2):       start the real server, then disconnect the player with
 *     a message telling them to reconnect in a moment
 *
 * The listener must release the port before the real server binds it, so waking closes
 * the listener first and only then starts the server.
 */

export type SleepState = 'sleeping' | 'waking';

interface SleepEntry {
  serverId: string;
  target: string;
  port: number;
  listener: net.Server;
  sleepingMotd: string;
  wakeMessage: string;
  state: SleepState;
  sleptAt: number;
  wakeStartedAt: number | null;
  lastWakeError: string | null;
  sockets: Set<net.Socket>;
}

const entries = new Map<string, SleepEntry>();

export interface SleepOptions {
  /** The panel's containerId — `process-<id>` or `mc-server-<id>`. */
  target: string;
  port: number;
  serverName?: string;
  sleepingMotd?: string;
  wakeMessage?: string;
}

export function isSleeping(serverId: string): boolean {
  return entries.has(serverId);
}

export function sleepInfo(serverId: string) {
  const entry = entries.get(serverId);
  if (!entry) return null;
  return {
    sleeping: true,
    state: entry.state,
    port: entry.port,
    sleptAt: new Date(entry.sleptAt).toISOString(),
    wakeStartedAt: entry.wakeStartedAt ? new Date(entry.wakeStartedAt).toISOString() : null,
    lastWakeError: entry.lastWakeError,
  };
}

export function listSleeping(): string[] {
  return Array.from(entries.keys());
}

/** Chat components are JSON; a plain string field is the simplest valid form. */
function chatJson(text: string): string {
  return JSON.stringify({ text });
}

function statusResponse(entry: SleepEntry, clientProtocol: number): Buffer {
  // Echoing the client's own protocol keeps the client from greying the entry out as
  // incompatible, so the MOTD is actually readable in the server list.
  const payload = JSON.stringify({
    version: { name: 'Sleeping', protocol: clientProtocol },
    players: { max: 0, online: 0, sample: [] },
    description: { text: entry.sleepingMotd },
  });

  const body = Buffer.from(payload, 'utf8');
  return frame(writeVarInt(0x00), writeVarInt(body.length), body);
}

function loginDisconnect(message: string): Buffer {
  const body = Buffer.from(chatJson(message), 'utf8');
  return frame(writeVarInt(0x00), writeVarInt(body.length), body);
}

function handleConnection(entry: SleepEntry, socket: net.Socket): void {
  let buffer = Buffer.alloc(0);
  let handled = false;

  entry.sockets.add(socket);
  socket.setTimeout(10_000);
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('close', () => entry.sockets.delete(socket));

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!handled) {
      let handshake: ReturnType<typeof parseHandshake>;
      try {
        handshake = parseHandshake(buffer);
      } catch {
        return socket.destroy();
      }
      if (!handshake) return; // Wait for the rest

      handled = true;
      buffer = buffer.subarray(handshake.consumed);

      if (handshake.nextState === 1) {
        socket.write(statusResponse(entry, handshake.protocol));
        return;
      }

      if (handshake.nextState === 2) {
        console.log(`[Sleeper] Login attempt on sleeping server '${entry.serverId}' — waking`);
        socket.write(loginDisconnect(entry.wakeMessage));
        socket.end();
        void wake(entry.serverId).catch((err) => {
          console.error(`[Sleeper] Wake failed for '${entry.serverId}':`, err.message);
        });
        return;
      }

      // Transfer/unknown next-state: nothing useful we can do
      return socket.destroy();
    }

    // After a status response the client sends a ping with an 8-byte payload and
    // expects it echoed back; that is what fills in the latency bars.
    const length = readVarInt(buffer, 0);
    if (!length) return;
    if (buffer.length < length.size + length.value) return;

    const packet = buffer.subarray(0, length.size + length.value);
    const packetId = readVarInt(packet, length.size);
    if (packetId && packetId.value === 0x01) {
      socket.write(packet);
    }
    socket.end();
  });
}

/**
 * Puts a stopped server to sleep by claiming its port.
 * The caller is responsible for having stopped the server first — binding fails otherwise.
 */
export async function sleep(serverId: string, options: SleepOptions): Promise<void> {
  const bare = bareServerId(serverId);
  if (entries.has(bare)) return; // Already asleep

  const name = options.serverName || 'This server';
  const entry: SleepEntry = {
    serverId: bare,
    target: options.target,
    port: options.port,
    listener: net.createServer(),
    sleepingMotd: options.sleepingMotd || `§e${name} is sleeping\n§7Join to wake it up`,
    wakeMessage:
      options.wakeMessage ||
      `§e${name} is waking up!\n\n§7It was asleep to save resources.\n§7Reconnect in about 30 seconds.`,
    state: 'sleeping',
    sleptAt: Date.now(),
    wakeStartedAt: null,
    lastWakeError: null,
    sockets: new Set(),
  };

  entry.listener.on('connection', (socket) => handleConnection(entry, socket));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: any) => {
      if (err.code === 'EADDRINUSE') {
        return reject(
          new Error(
            `Port ${options.port} is still in use — the server has not fully released it yet. ` +
              'Wait a few seconds after stopping before sleeping.'
          )
        );
      }
      reject(err);
    };

    entry.listener.once('error', onError);
    entry.listener.listen(options.port, '0.0.0.0', () => {
      entry.listener.removeListener('error', onError);
      resolve();
    });
  });

  entries.set(bare, entry);
  console.log(`[Sleeper] '${bare}' is asleep, holding port ${options.port}`);
}

/** Releases the port and hands it back to the real server. */
export async function wake(serverId: string): Promise<void> {
  const bare = bareServerId(serverId);
  const entry = entries.get(bare);
  if (!entry) return;

  if (entry.state === 'waking') return; // A second joiner shouldn't start it twice
  entry.state = 'waking';
  entry.wakeStartedAt = Date.now();

  // Drop the port before the server tries to bind it
  await new Promise<void>((resolve) => {
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    entry.listener.close(() => resolve());
  });

  entries.delete(bare);

  try {
    await startTarget(entry.target);
    console.log(`[Sleeper] '${bare}' woke up`);
  } catch (err: any) {
    console.error(`[Sleeper] '${bare}' failed to start after wake:`, err.message);
    throw err;
  }
}

/** Cancels sleep without starting the server (e.g. the panel deleted it). */
export async function cancelSleep(serverId: string): Promise<void> {
  const bare = bareServerId(serverId);
  const entry = entries.get(bare);
  if (!entry) return;

  await new Promise<void>((resolve) => {
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    entry.listener.close(() => resolve());
  });

  entries.delete(bare);
  console.log(`[Sleeper] Sleep cancelled for '${bare}', port ${entry.port} released`);
}
