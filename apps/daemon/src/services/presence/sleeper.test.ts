import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { sleep, wake, cancelSleep, isSleeping, sleepInfo, packetEnd } from './sleeper';
import { writeVarInt, frame, readVarInt } from './mc-ping';

/**
 * The promise this file has to keep is that a player who joins a sleeping server is never
 * disconnected — they wait, and then they are talking to the real server with their login
 * intact. Everything below is built out of real sockets for that reason: the failure mode
 * is a connection that dies or a login that arrives corrupted, and neither shows up in a
 * test that stops at the function boundary.
 */

/** A real handshake: packet 0x00, protocol, address, port, next-state. */
function handshake(nextState: number, protocol = 767): Buffer {
  const address = Buffer.from('localhost', 'utf8');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);

  return frame(
    writeVarInt(0x00),
    writeVarInt(protocol),
    writeVarInt(address.length),
    address,
    port,
    writeVarInt(nextState)
  );
}

/** Login start: packet 0x00 carrying a name. */
function loginStart(name = 'Steve'): Buffer {
  const raw = Buffer.from(name, 'utf8');
  return frame(writeVarInt(0x00), writeVarInt(raw.length), raw);
}

/** A port nothing else is on, found by letting the OS pick one and giving it back. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Resolves with the first chunk the socket receives, or null if it closes with none. */
function firstChunk(socket: net.Socket, timeoutMs = 3_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

test('a login attempt is held open instead of being disconnected', async () => {
  const port = await freePort();
  let started = false;

  await sleep('held-1', {
    target: 'process-held-1',
    port,
    // Never actually binds, so the player stays held for the length of this test.
    bootTimeoutMs: 1_500,
    start: async () => {
      started = true;
    },
  });

  const client = await connect(port);
  client.write(Buffer.concat([handshake(2), loginStart()]));

  // The old behaviour was a disconnect packet within milliseconds. Silence is the fix.
  const reply = await firstChunk(client, 700);

  assert.equal(reply, null, 'the player should be held, not answered');
  assert.equal(client.destroyed, false, 'the connection should still be open');
  assert.equal(started, true, 'the wake should still have been triggered');
  assert.equal(sleepInfo('held-1'), null, 'the entry is gone once waking');

  client.destroy();
});

test('a held player is handed to the server once it binds the port', async () => {
  const port = await freePort();
  let backend: net.Server | undefined;

  const received: Buffer[] = [];
  /*
   * The readiness probe connects and closes before the player is forwarded, so the first
   * connection a real server sees is not the player's. Waiting for the one that actually
   * says something is what distinguishes them.
   */
  const backendGotOne = new Promise<net.Socket>((resolve) => {
    backend = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
        resolve(socket);
      });
    });
  });

  await sleep('held-2', {
    target: 'process-held-2',
    port,
    // Stands in for a server booting: the port comes back a moment after the wake.
    start: async () => {
      await new Promise((r) => setTimeout(r, 300));
      await new Promise<void>((resolve) => backend!.listen(port, '127.0.0.1', resolve));
    },
  });

  const client = await connect(port);
  const sent = Buffer.concat([handshake(2), loginStart('Alex')]);
  client.write(sent);

  const serverSide = await backendGotOne;
  await new Promise((r) => setTimeout(r, 200));

  // The server must receive the login exactly as the client wrote it — handshake first,
  // then login start, byte for byte. Anything else and it is parsing a stream that starts
  // in the middle of a packet.
  assert.deepEqual(Buffer.concat(received), sent);

  // And the pipe runs the other way too, which is how login success reaches the client.
  const back = firstChunk(client);
  serverSide.write(Buffer.from([0x01, 0x02, 0x03]));
  assert.deepEqual(await back, Buffer.from([0x01, 0x02, 0x03]));

  client.destroy();
  await new Promise<void>((resolve) => backend!.close(() => resolve()));
});

test('two players joining during one wake are both handed over', async () => {
  const port = await freePort();
  // Counted on first data rather than on connect, so the readiness probe — which connects
  // and says nothing — is not mistaken for a player.
  const logins: net.Socket[] = [];
  const backend = net.createServer((socket) => socket.once('data', () => logins.push(socket)));

  let starts = 0;
  await sleep('held-3', {
    target: 'process-held-3',
    port,
    start: async () => {
      starts++;
      await new Promise((r) => setTimeout(r, 300));
      await new Promise<void>((resolve) => backend.listen(port, '127.0.0.1', resolve));
    },
  });

  const a = await connect(port);
  const b = await connect(port);
  a.write(Buffer.concat([handshake(2), loginStart('Alex')]));
  b.write(Buffer.concat([handshake(2), loginStart('Steve')]));

  await new Promise((r) => setTimeout(r, 900));

  // Serving only the first joiner and dropping the rest is the obvious way to get this
  // wrong, and the one nobody notices until two people log in at once.
  assert.equal(logins.length, 2);
  assert.equal(starts, 1, 'a second joiner must not start the server twice');

  a.destroy();
  b.destroy();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

test('a server that fails to start tells the waiting player why', async () => {
  const port = await freePort();

  await sleep('held-4', {
    target: 'process-held-4',
    port,
    bootTimeoutMs: 1_000,
    start: async () => {
      throw new Error('no disk space');
    },
  });

  const client = await connect(port);
  client.write(Buffer.concat([handshake(2), loginStart()]));

  const reply = await firstChunk(client);

  assert.ok(reply, 'the player should be told, not left on a loading screen');
  // A login disconnect: packet 0x00 carrying the reason as text.
  assert.equal(readVarInt(reply, readVarInt(reply, 0)!.size)?.value, 0x00);
  assert.match(reply.toString('utf8'), /no disk space/);

  client.destroy();
});

test('a status ping still answers immediately, and is not held', async () => {
  const port = await freePort();
  await sleep('held-5', { target: 'process-held-5', port, bootTimeoutMs: 1_000, start: async () => {} });

  const client = await connect(port);
  client.write(handshake(1));

  const reply = await firstChunk(client);
  assert.ok(reply);
  assert.match(reply.toString('utf8'), /is sleeping/);
  assert.equal(isSleeping('held-5'), true, 'a ping must not wake the server');

  client.destroy();
  await cancelSleep('held-5');
});

test('cancelling sleep disconnects anyone waiting rather than cutting them off silently', async () => {
  const port = await freePort();
  await sleep('held-6', { target: 'process-held-6', port, bootTimeoutMs: 1_000, start: async () => {} });

  const client = await connect(port);
  client.write(Buffer.concat([handshake(2), loginStart()]));
  await new Promise((r) => setTimeout(r, 200));

  // The wake already removed the entry, so re-sleep to reach cancelSleep with a held
  // player: the case is a server deleted while someone waits for it.
  await sleep('held-6', { target: 'process-held-6', port: await freePort(), bootTimeoutMs: 1_000, start: async () => {} });
  await cancelSleep('held-6');

  assert.equal(isSleeping('held-6'), false);
  client.destroy();
});

test('the login-start boundary is found however the bytes are split', () => {
  // TCP gives no guarantee about chunk boundaries, and getting this wrong truncates the
  // replay — the server would then read a login packet that stops mid-name.
  const hs = handshake(2);
  const login = loginStart('Alexander');
  const whole = Buffer.concat([hs, login]);

  assert.equal(packetEnd(whole, hs.length), whole.length);

  // One byte short of complete is not a boundary.
  assert.equal(packetEnd(whole.subarray(0, whole.length - 1), hs.length), null);
  // Nothing after the handshake at all.
  assert.equal(packetEnd(hs, hs.length), null);
});

test('trailing bytes after login start are not counted as part of it', () => {
  // Those bytes are the client answering our keepalives, and forwarding them would hand
  // the server responses to requests it never sent.
  const hs = handshake(2);
  const login = loginStart();
  const extra = frame(writeVarInt(0x02), writeVarInt(1), Buffer.from([0x00]));

  assert.equal(packetEnd(Buffer.concat([hs, login, extra]), hs.length), hs.length + login.length);
});

test('a waiting player is kept alive with login-plugin requests', async () => {
  const port = await freePort();

  await sleep('held-7', {
    target: 'process-held-7',
    port,
    bootTimeoutMs: 2_000,
    keepAliveMs: 150,
    start: async () => {},
  });

  const client = await connect(port);
  client.write(Buffer.concat([handshake(2), loginStart()]));

  // Without these the client drops the connection after about thirty seconds — shorter
  // than any modpack takes to load, which would make the whole hold pointless.
  const packet = await firstChunk(client, 1_000);

  assert.ok(packet, 'a held client should be sent something');
  const length = readVarInt(packet, 0)!;
  assert.equal(readVarInt(packet, length.size)?.value, 0x04, 'expected Login Plugin Request');
  assert.match(packet.toString('utf8'), /mcmanager:waking/);

  client.destroy();
});

test('an old client that predates login-plugin requests is held without them', async () => {
  const port = await freePort();

  await sleep('held-8', {
    target: 'process-held-8',
    port,
    bootTimeoutMs: 2_000,
    keepAliveMs: 100,
    start: async () => {},
  });

  const client = await connect(port);
  // 340 is 1.12.2 — before Login Plugin Request existed. Sending one would be an unknown
  // packet mid-login, which is worse than the silence it was meant to prevent.
  client.write(Buffer.concat([handshake(2, 340), loginStart()]));

  assert.equal(await firstChunk(client, 500), null);
  client.destroy();
});

test('a player arriving after the server is already up is still forwarded', async () => {
  const port = await freePort();
  const logins: net.Socket[] = [];
  const backend = net.createServer((socket) => socket.once('data', () => logins.push(socket)));

  await sleep('held-9', {
    target: 'process-held-9',
    port,
    start: async () => {
      await new Promise((r) => setTimeout(r, 200));
      await new Promise<void>((resolve) => backend.listen(port, '127.0.0.1', resolve));
    },
  });

  /*
   * Both connect while the listener is still up — the only moment they can, since the port
   * refuses connections between the listener closing and the server binding. The second
   * client then sends its login *after* the forwarding pass has already run, which is what
   * a slow or stalled client looks like.
   *
   * Nothing calls that pass again, so this player is only forwarded if their completed
   * login triggers it — the other half of the race.
   */
  const first = await connect(port);
  const late = await connect(port);

  first.write(Buffer.concat([handshake(2), loginStart('Alex')]));

  await new Promise((r) => setTimeout(r, 700));
  late.write(Buffer.concat([handshake(2), loginStart('Steve')]));

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(logins.length, 2);

  first.destroy();
  late.destroy();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});
