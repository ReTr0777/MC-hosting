import net from 'net';

/**
 * Minimal Server List Ping client.
 *
 * Player counts were previously only available in PROCESS mode, because they came from
 * parsing the child process's stdout. Sleep-on-empty needs a count that works for Docker
 * servers too, and the protocol every Minecraft client already speaks gives us one for
 * free — no console, no RCON, no mod required.
 *
 * Protocol: https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
 */

export interface PingResult {
  online: number;
  max: number;
  motd: string;
  version: string;
  protocol: number;
  latencyMs: number;
  /** Player names from the status response's "sample" field, if the server publishes one (not every player when online > sample size). Null if absent. */
  sampleNames: string[] | null;
}

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let temp = v & 0x7f;
    // Unsigned shift so negative protocol versions encode as the usual 5 bytes
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

export function readVarInt(buf: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0;
  let size = 0;

  while (true) {
    if (offset + size >= buf.length) return null; // Need more bytes
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 5) throw new Error('VarInt is too long');
  }

  return { value, size };
}

function writeString(str: string): Buffer {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Wraps a payload in the length-prefixed frame the protocol expects. */
export function frame(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Flattens the several shapes a MOTD can take (string, {text}, or component tree). */
export function flattenMotd(description: any): string {
  if (description == null) return '';
  if (typeof description === 'string') return description;

  let out = String(description.text || '');
  if (Array.isArray(description.extra)) {
    out += description.extra.map(flattenMotd).join('');
  }
  return out;
}

export interface Handshake {
  protocol: number;
  /** 1 = status ping, 2 = login. */
  nextState: number;
  consumed: number;
}

/**
 * Parses a client handshake packet — the server side of the same protocol.
 *
 * Returns null while bytes are still missing so the caller can wait for more data;
 * a handshake can arrive split across TCP segments.
 */
export function parseHandshake(buf: Buffer): Handshake | null {
  const length = readVarInt(buf, 0);
  if (!length) return null;

  const total = length.size + length.value;
  if (buf.length < total) return null;

  let cursor = length.size;

  const packetId = readVarInt(buf, cursor);
  if (!packetId || packetId.value !== 0x00) return null;
  cursor += packetId.size;

  const protocol = readVarInt(buf, cursor);
  if (!protocol) return null;
  cursor += protocol.size;

  const addrLen = readVarInt(buf, cursor);
  if (!addrLen) return null;
  cursor += addrLen.size + addrLen.value;

  cursor += 2; // Server port (unsigned short) — the listener already knows its own port

  const nextState = readVarInt(buf, cursor);
  if (!nextState) return null;

  return { protocol: protocol.value, nextState: nextState.value, consumed: total };
}

export async function pingServer(
  host: string,
  port: number,
  timeoutMs = 3000
): Promise<PingResult> {
  return new Promise<PingResult>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err: Error | null, result?: PingResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error(`Ping to ${host}:${port} timed out`)));
    socket.on('error', (err) => finish(err));

    socket.connect(port, host, () => {
      // Handshake: protocol -1 means "just querying", then next-state 1 = status
      const handshake = frame(
        writeVarInt(0x00),
        writeVarInt(-1),
        writeString(host),
        (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(port, 0);
          return b;
        })(),
        writeVarInt(1)
      );
      const statusRequest = frame(writeVarInt(0x00));
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        const length = readVarInt(buffer, 0);
        if (!length) return; // Length prefix not fully arrived yet

        const total = length.size + length.value;
        if (buffer.length < total) return; // Body still in flight

        let cursor = length.size;
        const packetId = readVarInt(buffer, cursor);
        if (!packetId) return;
        cursor += packetId.size;

        if (packetId.value !== 0x00) {
          return finish(new Error(`Unexpected status packet id ${packetId.value}`));
        }

        const jsonLen = readVarInt(buffer, cursor);
        if (!jsonLen) return;
        cursor += jsonLen.size;

        const json = JSON.parse(buffer.subarray(cursor, cursor + jsonLen.value).toString('utf8'));

        const sample = Array.isArray(json?.players?.sample) ? json.players.sample : null;

        finish(null, {
          online: Number(json?.players?.online ?? 0),
          max: Number(json?.players?.max ?? 0),
          motd: flattenMotd(json?.description),
          version: String(json?.version?.name ?? 'unknown'),
          protocol: Number(json?.version?.protocol ?? -1),
          latencyMs: Date.now() - startedAt,
          sampleNames: sample ? sample.map((p: any) => String(p?.name || '')).filter(Boolean) : null,
        });
      } catch (err: any) {
        finish(err);
      }
    });
  });
}

/** Ping that answers "unknown" rather than throwing — for bulk polling. */
export async function tryPing(host: string, port: number, timeoutMs = 2000): Promise<PingResult | null> {
  try {
    return await pingServer(host, port, timeoutMs);
  } catch {
    return null;
  }
}
