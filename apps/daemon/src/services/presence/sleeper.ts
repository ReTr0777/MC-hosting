import net from 'net';
import { writeVarInt, readVarInt, frame, parseHandshake } from './mc-ping';
import { startTarget, bareServerId } from '../runtime/lifecycle';

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
 *   - login (next-state 2):       start the real server, hold the player's connection
 *     open, and hand it to the server once it is listening
 *
 * The player is never disconnected. They wait at "Logging in…" for as long as the boot
 * takes and then join, instead of being kicked with a note to come back in a minute and
 * having to remember to do it.
 *
 * What makes that possible is that closing a net.Server stops it *accepting* new
 * connections but leaves the sockets it already accepted alive. So the listener can hand
 * the port to the real server while still holding the people waiting on it:
 *
 *   1. buffer the client's handshake and login start, and answer neither
 *   2. close the listener, freeing the port
 *   3. start the server, and wait for it to bind
 *   4. dial it, replay the buffered bytes, and pipe the two sockets together
 *
 * From step 4 on this is a byte pipe and nothing more, so encryption, online-mode and
 * every protocol version work untouched — the server runs its own login exchange with
 * the client straight through.
 *
 * See docs/sleep-wake-plan.md for the design and what is deliberately not done here.
 */

export type SleepState = 'sleeping' | 'waking';

/**
 * A player waiting at "Logging in…" while the server boots.
 *
 * `replay` is the client's own handshake and login-start bytes, kept verbatim. They are
 * replayed to the real server rather than re-encoded, so nothing this file understands
 * imperfectly — an unfamiliar protocol version, a field that moved between releases —
 * can corrupt them on the way through.
 */
interface HeldConnection {
  socket: net.Socket;
  replay: Buffer | null;
  /** Where the handshake ends, so the login-start packet after it can be found. */
  handshakeEnd: number;
  protocol: number;
  keepAlive: NodeJS.Timeout | null;
  messageId: number;
  /** Guards against being handed over twice when both sides of the race fire together. */
  piped: boolean;
}

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
  held: Set<HeldConnection>;
  start: () => Promise<void>;
  bootTimeoutMs: number;
  keepAliveMs: number;
  /**
   * Whether the server is up and taking connections.
   *
   * Latecomers are the reason this is kept: a player whose login lands after the forwarding
   * pass has already run would otherwise wait forever for a hand-over that is never coming
   * again. With it, they are piped straight through as soon as their login is complete.
   */
  up: boolean;
}

/**
 * How long to wait for the woken server to start listening.
 *
 * Generous because the thing being waited for is a modpack loading a few hundred mods on
 * whatever hardware the node happens to be — a phone, in at least one case. The player is
 * being kept alive deliberately (see keepAlive below), so a long wait costs them a
 * loading screen rather than a broken connection.
 */
const BOOT_TIMEOUT_MS = 10 * 60_000;
const BIND_POLL_MS = 500;

/**
 * Interval between login-plugin requests sent to a waiting client.
 *
 * The client drops a connection that has been silent for about thirty seconds, which is
 * shorter than any modpack takes to boot. Login state has no keepalive packet, but it
 * does have Login Plugin Request — a server may send one at any point during login and
 * the client must answer. Sending one periodically on a channel no client implements
 * feeds both sides' timeouts: ours by their reply, theirs by our request.
 *
 * The exchange stays between this file and the client. Only the buffered handshake and
 * login start are replayed onward, so the real server never sees that it happened.
 */
const KEEPALIVE_MS = 10_000;

/** Login Plugin Request arrived in 1.13. Older clients are held without it. */
const MIN_PROTOCOL_FOR_PLUGIN_REQUEST = 393;

const entries = new Map<string, SleepEntry>();

export interface SleepOptions {
  /** The panel's containerId — `process-<id>` or `mc-server-<id>`. */
  target: string;
  port: number;
  serverName?: string;
  sleepingMotd?: string;
  wakeMessage?: string;
  /**
   * How to start the server. Defaults to the real launcher.
   *
   * A seam for the tests, which need to exercise handing a live socket to a server that
   * binds the port — the part of this file most likely to be wrong and least likely to be
   * noticed, since a mistake there shows up as players stuck on a loading screen rather
   * than as anything the daemon logs.
   */
  start?: () => Promise<void>;
  /** How long to wait for the server to bind before giving up. Defaults to BOOT_TIMEOUT_MS. */
  bootTimeoutMs?: number;
  /** Interval between keepalives sent to waiting players. Defaults to KEEPALIVE_MS. */
  keepAliveMs?: number;
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
    /** Players sitting at "Logging in…" waiting for this wake to finish. */
    waitingPlayers: entry.held.size,
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

/**
 * Login Plugin Request (clientbound 0x04): message id, channel, then an empty payload.
 *
 * Sent purely so that something is sent — see KEEPALIVE_MS. The channel is deliberately
 * one nothing implements, so every client answers "not understood" and no mod mistakes it
 * for a handshake of its own.
 *
 * Written without compression framing on purpose: Set Compression is part of the login
 * exchange the real server has not started yet, so nothing is compressed at this point.
 */
function loginPluginRequest(messageId: number): Buffer {
  const channel = Buffer.from('mcmanager:waking', 'utf8');
  return frame(writeVarInt(0x04), writeVarInt(messageId), writeVarInt(channel.length), channel);
}

/**
 * End offset of the packet beginning at `offset`, or null if it has not all arrived.
 *
 * Used to find where login start ends without interpreting any of it. What the packet
 * contains has changed across versions — a bare name, then a UUID, then a signature block
 * — and none of that matters to a byte pipe. Its length prefix has not changed.
 */
export function packetEnd(buf: Buffer, offset: number): number | null {
  const length = readVarInt(buf, offset);
  if (!length) return null;

  const end = offset + length.size + length.value;
  return buf.length >= end ? end : null;
}

/**
 * Takes a connection out of the request/response path and parks it until the server is up.
 */
function hold(entry: SleepEntry, socket: net.Socket, protocol: number): HeldConnection {
  const held: HeldConnection = {
    socket,
    replay: null,
    handshakeEnd: 0,
    protocol,
    keepAlive: null,
    messageId: 1,
    piped: false,
  };

  /*
   * The idle timeout has to go. It exists to hang up on clients that connect and say
   * nothing, and a held player is exactly that by design — silent for as long as the
   * server takes to boot.
   */
  socket.setTimeout(0);
  socket.on('close', () => release(entry, held));

  if (protocol >= MIN_PROTOCOL_FOR_PLUGIN_REQUEST) {
    held.keepAlive = setInterval(() => {
      if (socket.destroyed) return;
      socket.write(loginPluginRequest(held.messageId++));
    }, entry.keepAliveMs);
    // Nothing should be kept alive by this on the way to shutdown.
    held.keepAlive.unref?.();
  }

  entry.held.add(held);
  return held;
}

/** Stops the keepalive and forgets the connection. Safe to call more than once. */
function release(entry: SleepEntry, held: HeldConnection): void {
  if (held.keepAlive) {
    clearInterval(held.keepAlive);
    held.keepAlive = null;
  }
  entry.held.delete(held);
}

/**
 * Records the handshake and login-start bytes once both have arrived.
 *
 * Until the login-start packet is complete there is nothing to replay, and a client that
 * never sends one is dropped when the server comes up rather than being forwarded
 * halfway through a login.
 */
function captureReplay(held: HeldConnection, buffer: Buffer): void {
  if (held.replay) return;

  const end = packetEnd(buffer, held.handshakeEnd);
  if (end !== null) held.replay = Buffer.from(buffer.subarray(0, end));
}

/**
 * Hands a player over if there is now both a server to hand them to and a login to hand it.
 *
 * Called from both ends of the race: the forwarding pass when the server comes up, and the
 * client's own data as their login completes. Whichever happens second does the work.
 */
function maybeForward(entry: SleepEntry, held: HeldConnection): void {
  if (entry.up && held.replay && !held.piped) pipeToServer(entry, held);
}

function handleConnection(entry: SleepEntry, socket: net.Socket): void {
  let buffer = Buffer.alloc(0);
  let handled = false;
  /** Set once this connection becomes a player being held; see HeldConnection. */
  let heldConn: HeldConnection | null = null;

  entry.sockets.add(socket);
  /*
   * Short, because a socket that has not said anything is a scanner or a stalled client.
   * A held player has this cleared — they are meant to sit silent for minutes, and this
   * timeout would otherwise disconnect the very people the hold exists to keep.
   */
  socket.setTimeout(10_000);
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('close', () => entry.sockets.delete(socket));

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    /*
     * Once held, the only thing still wanted from this client is the login-start packet
     * that completes the replay. Everything after it — their answers to our keepalives —
     * is read and dropped, since the real server must receive the login exchange from its
     * own beginning and not the middle of one it never saw.
     */
    if (heldConn) {
      if (!heldConn.replay) {
        captureReplay(heldConn, buffer);
        maybeForward(entry, heldConn);
      }
      return;
    }

    if (!handled) {
      let handshake: ReturnType<typeof parseHandshake>;
      try {
        handshake = parseHandshake(buffer);
      } catch {
        return socket.destroy();
      }
      if (!handshake) return; // Wait for the rest

      handled = true;

      if (handshake.nextState === 1) {
        buffer = buffer.subarray(handshake.consumed);
        socket.write(statusResponse(entry, handshake.protocol));
        return;
      }

      if (handshake.nextState === 2) {
        console.log(`[Sleeper] Login attempt on sleeping server '${entry.serverId}' — waking, holding the player`);

        // Held whole rather than trimmed: the handshake is the first thing the real
        // server needs to be told, so those bytes are part of the replay.
        heldConn = hold(entry, socket, handshake.protocol);
        heldConn.handshakeEnd = handshake.consumed;
        captureReplay(heldConn, buffer);
        maybeForward(entry, heldConn);

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
    // Only reached when a wake fails now that joining holds the connection instead of
    // rejecting it. Kept configurable because the panel already exposes it.
    wakeMessage: options.wakeMessage || `§e${name} could not be woken up.\n\n§7Try again in a moment.`,
    state: 'sleeping',
    sleptAt: Date.now(),
    wakeStartedAt: null,
    lastWakeError: null,
    sockets: new Set(),
    held: new Set(),
    start: options.start || (() => startTarget(options.target)),
    bootTimeoutMs: options.bootTimeoutMs ?? BOOT_TIMEOUT_MS,
    keepAliveMs: options.keepAliveMs ?? KEEPALIVE_MS,
    up: false,
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

  /*
   * Drop the port before the server tries to bind it.
   *
   * Only the transient sockets go — status pings and half-finished handshakes. Held
   * players are kept: closing the listener stops new connections being accepted but
   * leaves these alive, which is the whole basis of forwarding them later.
   *
   * The gap between this and the server binding is a few seconds during which the port
   * refuses connections. A player arriving in that window sees a failed connection and
   * retries into a server that is by then starting, which is the same outcome they used
   * to get from every attempt.
   */
  /*
   * Nothing is destroyed here.
   *
   * An earlier version cleared every socket that was not yet held, which looked like tidying
   * up after status pings. It was not: a player who had connected but whose first packet had
   * not arrived yet is indistinguishable from one of those, and got their connection killed
   * because somebody else triggered the wake a few milliseconds earlier. Status pings end
   * themselves, and anything silent is dropped by the ten-second idle timeout, so there was
   * never anything to gain here.
   */

  /*
   * close() and do not wait for its callback.
   *
   * The callback fires when the last connection has gone, not when the port is free — and
   * the held players are meant never to go, so waiting for it waits forever. This is not a
   * theoretical concern: it deadlocked the wake outright, and the server never started.
   *
   * The listening handle itself is released by the call, so the port is bindable from
   * here. One turn of the loop gives libuv the chance to do it.
   */
  entry.listener.close();
  await new Promise((resolve) => setImmediate(resolve));

  entries.delete(bare);

  try {
    await entry.start();
    console.log(`[Sleeper] '${bare}' woke up`);
  } catch (err: any) {
    console.error(`[Sleeper] '${bare}' failed to start after wake:`, err.message);
    // The people waiting are told why, rather than being left on a loading screen for a
    // server that is never going to answer.
    dropHeld(entry, `§cCould not start the server:\n\n§7${err.message}`);
    throw err;
  }

  await forwardHeld(entry);
}

/** True once something is accepting connections on the port again. */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    const done = (result: boolean) => {
      probe.destroy();
      resolve(result);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(2_000, () => done(false));
  });
}

/**
 * Waits for the server to start listening, then hands every waiting player to it.
 *
 * A bound port is taken as ready because a Minecraft server binds at the end of its
 * startup, immediately before it is able to accept logins — not at the beginning, which
 * would make this a race.
 */
async function forwardHeld(entry: SleepEntry): Promise<void> {
  if (entry.held.size === 0) return;

  const deadline = Date.now() + entry.bootTimeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepts(entry.port)) {
      entry.up = true;
      for (const held of [...entry.held]) maybeForward(entry, held);
      return;
    }
    await new Promise((r) => setTimeout(r, BIND_POLL_MS));
  }

  dropHeld(
    entry,
    `§cThe server did not finish starting in time.\n\n` +
      '§7Try again, or ask an administrator to check the console.'
  );
}

/** Connects one waiting player to the now-running server and gets out of the way. */
function pipeToServer(entry: SleepEntry, held: HeldConnection): void {
  held.piped = true;
  release(entry, held);

  if (held.socket.destroyed) return;
  if (!held.replay) {
    // Connected, was held, but never sent a login start. Forwarding a login that does not
    // exist would hand the server a stream starting mid-packet.
    console.warn(`[Sleeper] Dropping a held connection to '${entry.serverId}' that never sent a login`);
    return void held.socket.destroy();
  }

  const upstream = net.connect({ host: '127.0.0.1', port: entry.port }, () => {
    upstream.write(held.replay!);
    // From here neither side is interpreted. Everything the server and client have to say
    // to each other — encryption, compression, the login itself — passes through as bytes.
    held.socket.pipe(upstream);
    upstream.pipe(held.socket);
    console.log(`[Sleeper] Handed a waiting player to '${entry.serverId}'`);
  });

  upstream.on('error', (err: any) => {
    console.error(`[Sleeper] Could not hand a player to '${entry.serverId}':`, err.message);
    if (!held.socket.destroyed) {
      held.socket.write(loginDisconnect('§cThe server started but refused the connection.\n\n§7Try joining again.'));
      held.socket.end();
    }
  });

  /*
   * Either side going takes the other with it.
   *
   * pipe() only forwards a graceful end, and a player who alt-F4s or loses their
   * connection does not send one — so without this, every abrupt disconnect leaves a
   * socket open to the server for the lifetime of the daemon.
   */
  held.socket.on('error', () => upstream.destroy());
  held.socket.on('close', () => upstream.destroy());
  upstream.on('close', () => held.socket.destroy());
}

/** Disconnects everyone waiting, with a reason they can read. */
function dropHeld(entry: SleepEntry, message: string): void {
  for (const held of [...entry.held]) {
    release(entry, held);
    if (held.socket.destroyed) continue;
    held.socket.write(loginDisconnect(message));
    held.socket.end();
  }
}

/** Cancels sleep without starting the server (e.g. the panel deleted it). */
export async function cancelSleep(serverId: string): Promise<void> {
  const bare = bareServerId(serverId);
  const entry = entries.get(bare);
  if (!entry) return;

  // Anyone waiting is told, rather than having the connection cut from under them with no
  // explanation. Cancelling happens when the server is deleted or taken over by the panel,
  // and neither of those is going to end with them joining.
  dropHeld(entry, `§eThis server is no longer available.\n\n§7Ask an administrator if you were expecting it.`);

  for (const socket of entry.sockets) socket.destroy();
  entry.sockets.clear();
  // Same reasoning as wake(): the callback waits for connections, not for the port.
  entry.listener.close();
  await new Promise((resolve) => setImmediate(resolve));

  entries.delete(bare);
  console.log(`[Sleeper] Sleep cancelled for '${bare}', port ${entry.port} released`);
}
