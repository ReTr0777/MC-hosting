import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { isHealthOnline } from '@/lib/services/node-status';
import { writeAudit } from '@/lib/audit';
import { canManageNode, canSeeNode } from '@/lib/servers/node-access';
import { directCandidates } from '@/lib/servers/node-enrollment';

export const dynamic = 'force-dynamic';

/**
 * Looks for a node again at every address it has ever offered, and re-registers it at
 * whichever one answers.
 *
 * The address a node was enrolled at goes stale for entirely ordinary reasons: DHCP hands
 * the machine a different one, a laptop moves to another network, or — the case this was
 * written for — Windows Firewall was blocking the probe at enrollment, the node fell back
 * to a tunnel, and the firewall has since been opened. In all of them the node is running
 * perfectly and the panel is knocking at the wrong door, with "offline" as the only
 * symptom and a fresh setup code as the only cure.
 *
 * Preference is deliberate, and it is the tunnel: a node published through frps needs
 * nothing open on its own side and keeps answering when the machine changes network or
 * lease, neither of which is true of the LAN address it also happens to respond on today.
 * Direct is tried after it rather than instead of it, so a node whose tunnel is genuinely
 * down is still found — this is a button somebody pressed to locate a node, and returning
 * nothing when the machine is plainly reachable would be the wrong answer.
 */

const PROBE_TIMEOUT_MS = 4000;

interface Answer {
  host: string;
  port: number;
  health: any;
}

async function probe(host: string, port: number, apiKey: string): Promise<Answer | null> {
  try {
    const health = await new DaemonClient({ host, port, apiKey }).getHealth(PROBE_TIMEOUT_MS);
    return health ? { host, port, health } : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const node = await prisma.node.findUnique({ where: { id: params.id } });
  if (!node || !canSeeNode(user, node)) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }
  if (!canManageNode(user, node)) {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  /*
   * Every address, each at the port that makes sense for it.
   *
   * The stored candidates are the machine's own network addresses, which its daemon
   * listens on at candidatePort — not at the tunnel port the node may be registered at.
   * Conflating the two probes a LAN address at a port nothing on that machine uses.
   */
  const localPort = node.candidatePort ?? node.port;
  /*
   * The registered port differing from the port the node reports listening on is what marks
   * a tunnelled node: enrollment gave it a remote port on frps, with its own 3500 behind.
   */
  const tunnelled = Boolean(node.candidatePort && node.port !== node.candidatePort);
  const registered = { host: node.host, port: node.port };
  const directAttempts = directCandidates(node.candidateAddresses).map((host) => ({
    host,
    port: localPort,
  }));
  const attempts: Array<{ host: string; port: number }> = tunnelled
    ? // The tunnel first, so a node that is reachable both ways stays on the route that
      // survives it moving.
      [registered, ...directAttempts]
    : // Nothing to prefer, so the candidates lead and the recorded address comes last:
      // reaching it changes nothing but does confirm the node is alive where it was.
      [...directAttempts, registered];

  const results = await Promise.all(attempts.map((a) => probe(a.host, a.port, node.apiKey)));
  const answer = results.find((r): r is Answer => r !== null);

  if (!answer) {
    return NextResponse.json(
      {
        error:
          `No answer from ${attempts.map((a) => `${a.host}:${a.port}`).join(', ')}. ` +
          'The node is off, or a firewall is blocking the panel from reaching it.',
        tried: attempts.map((a) => `${a.host}:${a.port}`),
      },
      { status: 502 }
    );
  }

  const moved = answer.host !== node.host || answer.port !== node.port;
  const updated = await prisma.node.update({
    where: { id: node.id },
    data: {
      host: answer.host,
      port: answer.port,
      isOnline: isHealthOnline(answer.health),
      liveLastSeenAt: new Date(),
    },
    select: { id: true, name: true, host: true, port: true, isOnline: true },
  });

  if (moved) {
    await writeAudit({
      userId: user.userId,
      action: 'NODE_RELOCATE',
      details: {
        nodeId: node.id,
        name: node.name,
        from: `${node.host}:${node.port}`,
        to: `${answer.host}:${answer.port}`,
      },
    });
  }

  return NextResponse.json({
    node: updated,
    moved,
    message: moved
      ? `Found at ${answer.host}:${answer.port} — the node has been re-registered there.`
      : `Answered at ${answer.host}:${answer.port}, which is where it was already registered.`,
  });
}
