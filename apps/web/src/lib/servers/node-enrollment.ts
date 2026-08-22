import crypto from 'crypto';

/**
 * Claim codes: the handshake that lets a customer's own machine become a node.
 *
 * The old route needed a global admin at a keyboard — invent a bearer token, create the
 * node row by hand, export the config file, get it onto the other machine. Every step
 * moved a secret through a human, and the last one moved it through whatever chat app
 * was open at the time.
 *
 * A claim code inverts that. The panel issues a short code that is worth nothing on its
 * own and expires in minutes; the desktop app posts it back along with a key the machine
 * generated locally. The daemon key is never typed, never mailed, and never leaves the
 * node except in the one request that registers it.
 *
 * Everything here is pure so the format, the expiry and the port allocation can be
 * tested without a database.
 */

/** No I, L, O, U, 0 or 1: this is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;

/** Long enough to walk to the other machine, short enough that a forgotten code is harmless. */
export const ENROLL_TTL_MS = 15 * 60_000;

/**
 * Remote ports frps may hand out for node APIs.
 *
 * The constraint that matters is not "a free number" — it is that the tunnel server's
 * container publishes the port on its host. frps will happily accept a proxy on any port
 * it is asked for and listen inside its own network namespace; if Docker was never told
 * to publish that port, the panel dials it from outside and reaches nothing. The node then
 * sits offline forever with a tunnel it believes is up, which is exactly what a hardcoded
 * 26000-26999 produced against a deployment publishing 25000-25100.
 *
 * So the range is configuration, and its default sits above the band the game servers' own
 * tunnels use. Those are allocated from 24000 upward (see the servers route) through 25000,
 * so 25051-25100 is clear of them with room to spare. Changing it means changing what frps
 * publishes to match — or nothing at all where frps runs on host networking, which is what
 * the Unraid template ships.
 */
export const TUNNEL_API_PORT_MIN = 25051;
export const TUNNEL_API_PORT_MAX = 25100;

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_TUNNEL_API_RANGE: PortRange = {
  min: TUNNEL_API_PORT_MIN,
  max: TUNNEL_API_PORT_MAX,
};

/**
 * Reads a "start-end" range, falling back to the default for anything unusable.
 *
 * Falls back rather than throws: this comes from an environment variable, and a typo in it
 * must not take enrollment down — a node registered in the default range is a fixable
 * mistake, a panel that refuses to enroll anything is not obviously one at all.
 */
export function parseTunnelPortRange(raw: string | null | undefined): PortRange {
  const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(raw ?? '');
  if (!match) return DEFAULT_TUNNEL_API_RANGE;

  const min = Number(match[1]);
  const max = Number(match[2]);
  const sane = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
  if (!sane(min) || !sane(max) || max < min) return DEFAULT_TUNNEL_API_RANGE;

  return { min, max };
}

/** A fresh code, formatted in two groups because eight unbroken characters mis-type. */
export function generateEnrollCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

/**
 * The comparable form of whatever the user typed.
 *
 * Case, spaces and the dash are all presentation. Returns null when what is left cannot
 * be a code at all, so the caller can say so without a database round trip.
 */
export function normaliseEnrollCode(raw: string | null | undefined): string | null {
  const stripped = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== CODE_LENGTH) return null;
  for (const ch of stripped) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return stripped;
}

/** Codes are stored hashed: an unclaimed row is a credential until it is redeemed. */
export function hashEnrollCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Whether a stored enrollment can still be redeemed. */
export function enrollmentUsable(
  enrollment: { expiresAt: Date; claimedAt: Date | null },
  now: Date = new Date()
): boolean {
  if (enrollment.claimedAt) return false;
  return enrollment.expiresAt.getTime() > now.getTime();
}

/**
 * The next free tunnel port, or null when the range is exhausted.
 *
 * Lowest free port rather than a random one: the allocation is small enough to read at a
 * glance in frps' logs, and a node that re-enrolls tends to get its old port back.
 */
export function allocateTunnelPort(
  used: Iterable<number>,
  range: PortRange = DEFAULT_TUNNEL_API_RANGE
): number | null {
  const taken = new Set(used);
  for (let port = range.min; port <= range.max; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}

/**
 * A node name from what the machine reported about itself.
 *
 * The user may have named it when asking for the code; failing that the hostname is far
 * more recognisable than anything generated, since it is what they see on the machine
 * itself. Only if both are useless does this fall back to something generic.
 */
export function nodeNameFrom(requested: unknown, hostname: unknown): string {
  const clean = (v: unknown) =>
    typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  return clean(requested) || clean(hostname) || 'My machine';
}

/**
 * Whether an address can only ever describe the machine that reported it.
 *
 * Loopback is the obvious one. Link-local (169.254.x.x, and fe80:: on the v6 side) is the
 * one that actually bites: Windows hands it out to virtual adapters that never got a DHCP
 * lease — Hyper-V, WSL, a disconnected Wi-Fi card — and a machine can easily list one
 * ahead of its real LAN address. Registering a node there produces an address nothing
 * answers on, which is indistinguishable from a node that is simply offline.
 */
function unroutable(address: string): boolean {
  const a = address.toLowerCase();
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost' || a === '0.0.0.0') return true;
  if (a.startsWith('169.254.')) return true;
  if (a.startsWith('fe80:')) return true;
  return false;
}

/**
 * Addresses worth trying a direct connection to, in the order they should be tried.
 *
 * Order is preserved rather than ranked: the node lists its interfaces in the order its OS
 * reports them, and the panel proves reachability by connecting rather than by guessing
 * which subnet looks most like a LAN. All this does is drop the addresses that cannot be a
 * route to anywhere — see `unroutable` — so none of them can be picked as the fallback
 * address when no route is found at all.
 */
export function directCandidates(addresses: unknown): string[] {
  if (!Array.isArray(addresses)) return [];
  return addresses
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length < 64 && !/[^A-Za-z0-9.:_-]/.test(a))
    .filter((a) => !unroutable(a))
    .slice(0, 8);
}
