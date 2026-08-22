import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { isHealthOnline } from '@/lib/services/node-status';
import { writeAudit } from '@/lib/audit';
import { directCandidates } from '@/lib/servers/node-enrollment';

export const dynamic = 'force-dynamic';

/**
 * "Can you actually see me?" — asked by a node that has just applied its settings.
 *
 * Enrollment alone proves nothing. It records an address, the node restarts into whatever
 * configuration it was handed, and whether the panel can reach the result is not known by
 * anybody until the next poll marks the node offline for reasons nobody is watching. Every
 * failure so far has lived in that gap: a firewall silently refusing the probe, a tunnel
 * port the tunnel server never published, an address that was right yesterday.
 *
 * So the node asks, repeatedly, while its tunnel comes up — frpc needs a few seconds, and
 * a cold Docker start rather longer — and the panel answers with the truth: which address
 * it reached, or every address it tried and failed. The node is registered at whatever
 * actually worked, so setup ends in a node that is online or a sentence explaining why not.
 *
 * Authenticated by the node's own daemon key, which is the one secret both ends already
 * share and which is worthless to anyone who does not also hold the machine.
 */

const PROBE_TIMEOUT_MS = 4000;

interface Reached {
  host: string;
  port: number;
  health: any;
  via: 'tunnel' | 'direct';
}

async function probe(
  host: string,
  port: number,
  apiKey: string,
  via: 'tunnel' | 'direct'
): Promise<Reached | null> {
  try {
    const health = await new DaemonClient({ host, port, apiKey }).getHealth(PROBE_TIMEOUT_MS);
    return health ? { host, port, health, via } : null;
  } catch {
    return null;
  }
}

/** Timing-safe, and false rather than throwing when the two are different lengths. */
function keyMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';

  if (!nodeId || !apiKey) {
    return NextResponse.json({ error: 'nodeId and apiKey are required' }, { status: 400 });
  }

  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  // One answer for "no such node" and "wrong key": from out here they are the same thing,
  // and distinguishing them would let anyone enumerate node ids.
  if (!node || !keyMatches(node.apiKey, apiKey)) {
    return NextResponse.json({ error: 'Unknown node' }, { status: 401 });
  }

  /*
   * Fresh addresses if the node offered them — a machine that has moved network since it
   * enrolled is describing itself better now than its enrollment record does.
   */
  const reported = directCandidates(body?.addresses);
  const localPort = Number(body?.port) || node.candidatePort || node.port;
  const candidates = reported.length > 0 ? reported : directCandidates(node.candidateAddresses);

  /*
   * A tunnelled node is asked about at its tunnel and nowhere else.
   *
   * The registered port differing from the port the node says it listens on is what marks
   * one: enrollment gave it a remote port on frps, and the node's own 3500 is what sits
   * behind it.
   *
   * The LAN addresses are deliberately not tried as a fallback for those. A node on the
   * panel's own network will often answer on both, and letting the direct probe win when
   * the tunnel is a few seconds behind would quietly relocate the node onto an address that
   * needs a port open on its side and stops being true the moment the machine moves — the
   * exact arrangement the tunnel exists to avoid. Reporting the tunnel as unreachable is
   * the more useful answer too: it names the thing that is actually broken instead of
   * hiding it behind a route that happens to work today.
   */
  const tunnelled = Boolean(node.candidatePort && node.port !== node.candidatePort);
  const attempts = tunnelled
    ? [{ host: node.host, port: node.port, via: 'tunnel' as const }]
    : [
        ...candidates.map((host) => ({ host, port: localPort, via: 'direct' as const })),
        // Whatever it is registered at now, if the candidate list does not already cover it.
        { host: node.host, port: node.port, via: 'direct' as const },
      ];

  const results = await Promise.all(attempts.map((a) => probe(a.host, a.port, apiKey, a.via)));
  // First success in list order, so the preference above decides rather than the network's
  // timing does.
  const reached = results.find((r): r is Reached => r !== null);

  if (!reached) {
    return NextResponse.json(
      {
        ok: false,
        tried: attempts.map((a) => ({ address: `${a.host}:${a.port}`, via: a.via })),
      },
      { status: 200 }
    );
  }

  const moved = reached.host !== node.host || reached.port !== node.port;

  await prisma.node.update({
    where: { id: node.id },
    data: {
      host: reached.host,
      port: reached.port,
      isOnline: isHealthOnline(reached.health),
      liveLastSeenAt: new Date(),
      // Keep what the node says about itself current, so a later re-check has somewhere to look.
      ...(reported.length > 0 ? { candidateAddresses: reported } : {}),
      ...(Number(body?.port) ? { candidatePort: Number(body.port) } : {}),
    },
  });

  if (moved) {
    await writeAudit({
      userId: node.ownerId ?? undefined,
      action: 'NODE_RELOCATE',
      details: {
        nodeId: node.id,
        name: node.name,
        from: `${node.host}:${node.port}`,
        to: `${reached.host}:${reached.port}`,
        via: reached.via,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    via: reached.via,
    host: reached.host,
    port: reached.port,
    moved,
  });
}
