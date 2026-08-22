import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { DaemonClient } from '@/lib/services/daemon-client';
import { isHealthOnline } from '@/lib/services/node-status';
import { getPublicOrigin } from '@/lib/utils/public-url';
import { tryDecryptSecret } from '@/lib/auth/crypto';
import { buildFrpPreset, FRP_ADDR_KEY, FRP_PORT_KEY, FRP_TOKEN_KEY } from '@/lib/servers/frp';
import {
  allocateTunnelPort,
  directCandidates,
  enrollmentUsable,
  hashEnrollCode,
  nodeNameFrom,
  normaliseEnrollCode,
  parseTunnelPortRange,
} from '@/lib/servers/node-enrollment';

export const dynamic = 'force-dynamic';

/**
 * A machine registering itself as a node, using a claim code its owner got from the panel.
 *
 * This is the only route in the panel that takes no session — the caller is a freshly
 * installed daemon that has no account and no key anyone has agreed to yet. The claim
 * code is the whole of the authentication, which is why it is short-lived, single-use and
 * stored hashed.
 *
 * What the node sends is its own bearer key, generated locally on first run. The panel
 * stores it and thereafter authenticates to the node with it. Nobody types it, and it
 * crosses the wire exactly once.
 */

/** Direct reachability is worth a short wait and no more; the tunnel is the fallback. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Crude per-address throttle on wrong codes.
 *
 * Guessing an eight-character code inside its fifteen minutes is not a realistic attack,
 * but an unauthenticated endpoint that answers unlimited guesses invites someone to try.
 * In-memory is the right size for this: the window is a minute, and a restart losing the
 * counters costs nothing.
 */
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > ATTEMPT_LIMIT;
}

/** The address the *panel* dials to reach frps, which is not always what nodes dial. */
function panelFacingFrpHost(configured: string): string {
  // In the shipped compose file the panel reaches the tunnel server by container name
  // while nodes reach it at a public hostname. Same server, two names, and using the
  // node's name from inside the network resolves to nothing.
  return (process.env.FRP_PANEL_HOST || '').trim() || configured;
}

interface ProbeResult {
  host: string;
  health: any;
}

/**
 * The first address the panel can actually reach this node on, or null.
 *
 * Tried all at once rather than in turn. A machine at the other end of the internet fails
 * every one of these, which is the normal case for the customer this route exists for, and
 * in sequence that is four seconds per address spent proving what was already likely —
 * long enough for the node app to give up on the request before the panel answers it.
 * Concurrently the whole check costs one timeout, and the result still follows the order
 * the node listed its addresses in.
 */
async function probeDirect(
  addresses: string[],
  port: number,
  apiKey: string
): Promise<ProbeResult | null> {
  const results = await Promise.all(
    addresses.map(async (host) => {
      try {
        const health = await new DaemonClient({ host, port, apiKey }).getHealth(PROBE_TIMEOUT_MS);
        // A reply that is not recognisably this daemon is not a route to it.
        return health ? ({ host, health } as ProbeResult) : null;
      } catch {
        // Unreachable, refused, or the key did not match. All three mean "not this address".
        return null;
      }
    })
  );
  return results.find((r): r is ProbeResult => r !== null) ?? null;
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  if (tooManyAttempts(ip)) {
    return NextResponse.json(
      { error: 'Too many enrollment attempts. Wait a minute and try again.' },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  const code = normaliseEnrollCode(body.code);
  if (!code) {
    return NextResponse.json(
      { error: 'That is not a valid setup code. Ask the panel for a new one: Nodes → Connect a machine.' },
      { status: 400 }
    );
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length < 16) {
    return NextResponse.json({ error: 'The node sent no usable daemon key.' }, { status: 400 });
  }
  if (apiKey === 'default-daemon-secret-key') {
    // The daemon's published fallback. A node still carrying it has generated nothing.
    return NextResponse.json(
      { error: 'That node is still using the placeholder daemon key. Update the node app and try again.' },
      { status: 400 }
    );
  }

  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'The node sent an invalid port.' }, { status: 400 });
  }

  const enrollment = await prisma.nodeEnrollment.findUnique({
    where: { codeHash: hashEnrollCode(code) },
    select: { id: true, userId: true, name: true, expiresAt: true, claimedAt: true },
  });

  if (!enrollment || !enrollmentUsable(enrollment)) {
    // One message for absent, expired and already-used: from out here they are the same
    // situation, and telling them apart would confirm which codes ever existed.
    return NextResponse.json(
      {
        error:
          'That setup code is not valid any more. Codes last 15 minutes and work once — ' +
          'generate a fresh one in the panel.',
      },
      { status: 401 }
    );
  }

  const games = Array.isArray(body.enabledGames)
    ? body.enabledGames.filter((g: unknown) => typeof g === 'string')
    : [];
  const name = nodeNameFrom(enrollment.name ?? body.name, body.hostname);

  /*
   * How the panel will reach this machine, decided here rather than left to the user.
   *
   * The tunnel comes first whenever the installation has one, even for a machine sitting on
   * the panel's own LAN that a direct probe would have reached.
   *
   * Direct used to win that contest, and it is the worse answer for the machine this route
   * exists for. It needs an inbound port open on the node — a Windows Firewall rule at
   * least, a forwarded router port once the machine is anywhere else — which is exactly what
   * somebody plugging their own laptop in should never have to arrange. And it is registered
   * against an address that stops being true the moment the laptop goes home: a DHCP lease
   * expires, the machine joins another network, and the panel keeps dialling a host that now
   * belongs to somebody else's toaster.
   *
   * The tunnel is dialled outbound by the node, so it needs nothing open on the node's side
   * and survives the machine moving. Only the port frps republishes it on has to be
   * reachable, and only from the panel — which sits beside frps, so that stays inside the
   * network rather than on the router.
   */
  const candidates = directCandidates(body.addresses);

  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: [FRP_ADDR_KEY, FRP_PORT_KEY, FRP_TOKEN_KEY] } },
  });
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const frpToken = tryDecryptSecret(byKey[FRP_TOKEN_KEY] || '');
  const tunnelPreset = buildFrpPreset(byKey[FRP_ADDR_KEY], byKey[FRP_PORT_KEY], frpToken.value);

  /*
   * A token that will not decrypt must not be handed over as no token at all.
   *
   * tryDecryptSecret answers 'undecryptable' with an empty value, and an empty token is a
   * legitimate configuration - an frps with no auth - so nothing downstream can tell the
   * two apart. The node writes a config with no [auth] block, frpc logs in anonymously,
   * and frps answers "token in login doesn't match token from configuration". Which reads
   * as the node having the wrong token, when in fact the panel never sent one and cannot
   * read its own. That is a diagnosis worth hours, so it is refused here instead.
   */
  if (tunnelPreset && frpToken.status === 'undecryptable') {
    return NextResponse.json(
      {
        error:
          'The panel cannot decrypt its stored tunnel token, so it has nothing valid to give this ' +
          'node — SECRET_ENCRYPTION_KEY (or JWT_SECRET, if that is what the panel falls back to) ' +
          'changed since the token was saved. An administrator has to paste the tunnel token again ' +
          'under Settings → Tunnel, then this code can be used again.',
      },
      { status: 503 }
    );
  }

  let host: string;
  let registeredPort = port;
  let tunnel: { serverAddr: string; serverPort: number; token: string; apiRemotePort: number } | null =
    null;
  let reachability: 'direct' | 'tunnel' | 'unverified';
  /* Only probed when there is no tunnel to prefer; see above. */
  let direct: ProbeResult | null = null;

  if (tunnelPreset) {
    const frpHost = panelFacingFrpHost(tunnelPreset.serverAddr);
    const used = await prisma.node.findMany({ where: { host: frpHost }, select: { port: true } });
    /*
     * The range has to be one the tunnel server actually publishes on its host. frps
     * accepts a proxy on any port and listens for it inside its own container; a port
     * Docker was never told to publish is unreachable from where the panel dials it, and
     * the node stays offline with a tunnel that looks perfectly healthy from its end.
     */
    const range = parseTunnelPortRange(process.env.NODE_TUNNEL_PORT_RANGE);
    const remotePort = allocateTunnelPort(used.map((n) => n.port), range);
    if (remotePort === null) {
      return NextResponse.json(
        {
          error:
            `The panel has no tunnel ports left to give this node — ${range.min}-${range.max} are all in use. ` +
            'Ask an administrator to widen NODE_TUNNEL_PORT_RANGE and publish the wider range on the tunnel server.',
        },
        { status: 503 }
      );
    }
    host = frpHost;
    registeredPort = remotePort;
    tunnel = { ...tunnelPreset, apiRemotePort: remotePort };
    reachability = 'tunnel';
  } else {
    direct = await probeDirect(candidates, port, apiKey);

    if (direct) {
      /*
       * No tunnel in this installation, but the machine answers on its own address. Worth
       * taking, with the caveat above: it lasts exactly as long as that address does.
       */
      host = direct.host;
      reachability = 'direct';
    } else {
      /*
       * No route found and no tunnel configured. The node is still registered, at its best
       * guess of an address, because refusing here would leave the user with an installed
       * app, a used-up code and nothing in the panel — and the address may well start
       * working once they forward a port. It registers offline and says why.
       */
      host = candidates[0] || '';
      if (!host) {
        return NextResponse.json(
          {
            error:
              'The panel could not reach this machine and this installation has no tunnel configured. ' +
              'Ask an administrator to set up the FRP tunnel, or add the node by hand.',
          },
          { status: 409 }
        );
      }
      reachability = 'unverified';
    }
  }

  const health = direct?.health;
  const detectedMemory = Number(health?.memoryUsage?.total);
  const detectedCpu = Number(health?.cpuCores);
  const reportedMemory = Number(body.memoryMb);
  const reportedCpu = Number(body.cpuCores);

  const node = await prisma.node.create({
    data: {
      name,
      host,
      port: registeredPort,
      apiKey,
      ownerId: enrollment.userId,
      isOnline: direct ? isHealthOnline(direct.health) : false,
      // Whatever the machine could tell us about itself, then the health reply, then the
      // same placeholder a hand-registered node gets. A node that under-reports its size
      // simply takes fewer servers until its first ping corrects it.
      totalMemory:
        reportedMemory > 0 ? Math.round(reportedMemory) : detectedMemory > 0 ? detectedMemory : 8192,
      totalCpu: reportedCpu > 0 ? Math.round(reportedCpu) : detectedCpu > 0 ? detectedCpu : 4,
      // Kept whether or not they worked this time: a machine the panel could not reach
      // today is often reachable tomorrow, once a firewall rule exists or a laptop is back
      // on the right network, and /recheck looks here rather than asking for a new code.
      candidateAddresses: candidates,
      candidatePort: port,
      ...(games.length > 0 ? { enabledGames: games } : {}),
    },
    select: { id: true, name: true, host: true, port: true, isOnline: true },
  });

  /*
   * Claimed only now, and conditionally, so two machines racing the same code cannot both
   * get a node out of it: the second update matches nothing and its node is rolled back.
   */
  const claimed = await prisma.nodeEnrollment.updateMany({
    where: { id: enrollment.id, claimedAt: null },
    data: { claimedAt: new Date(), nodeId: node.id },
  });

  if (claimed.count === 0) {
    await prisma.node.delete({ where: { id: node.id } }).catch(() => {});
    return NextResponse.json(
      { error: 'That setup code has just been used by another machine.' },
      { status: 409 }
    );
  }

  await writeAudit({
    userId: enrollment.userId,
    action: 'NODE_ENROLL',
    details: { nodeId: node.id, name: node.name, host: node.host, port: node.port, reachability },
  });

  return NextResponse.json(
    {
      node: { id: node.id, name: node.name, host: node.host, port: node.port },
      // The node writes these and restarts its tunnel; without them a NAT'd machine has
      // no way to be reached and the row above would describe an address nobody answers.
      tunnel,
      reachability,
      panelUrl: await getPublicOrigin(req),
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } }
  );
}
