import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { nodeCapacity } from '@/lib/servers/node-capacity';
import { canManageNode, canSeeNode, isNodeAdmin } from '@/lib/servers/node-access';

/**
 * The node, the servers on it, and what it has promised them.
 *
 * The list view deliberately carries only a server *count* per node, which is enough to
 * decide where to put the next one and useless for every other question. Before this,
 * finding out what was actually running on a box meant reading every server card looking
 * for its name — so a node could not be drained, updated or diagnosed without guessing
 * what would be disrupted.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const node = await prisma.node.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, host: true, port: true, isOnline: true, ownerId: true,
      totalMemory: true, totalCpu: true, offloadPriority: true,
      overcommitRatio: true, cpuOvercommitRatio: true, enabledGames: true,
      drainedAt: true,
      liveCpuUsage: true, liveRamUsed: true, liveRamTotal: true,
      liveDiskUsed: true, liveDiskTotal: true, liveCpuModel: true,
      liveCpuCores: true, liveOsDistro: true, liveCpuTemp: true,
      liveJavaMajor: true, liveDataDiskFreeMb: true, liveDaemonVersion: true, liveLastSeenAt: true,
      createdAt: true,
      servers: {
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, status: true, game: true, memoryMb: true,
          cpuLimit: true, serverPort: true, serverType: true, mcVersion: true,
          // Access is granted through ServerPermission rather than an owner column, so
          // this is what decides whether a non-admin may be told this server exists.
          permissions: { select: { userId: true } },
        },
      },
    },
  });

  // A machine someone enrolled themselves is not part of the shared fleet, and to
  // everybody else it is indistinguishable from a node that does not exist.
  if (!node || !canSeeNode(user, node)) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  /*
   * Everyone may look at a node, but only an admin sees every server on it — a normal
   * user learns which of their own servers live here and nothing about anyone else's.
   * serverCount stays the true total either way, so the page can still say how loaded
   * the node is without naming what it is loaded with.
   */
  const isAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const visible = isAdmin
    ? node.servers
    : node.servers.filter((s) => s.permissions.some((p) => p.userId === user.userId));

  return NextResponse.json({
    node: {
      ...node,
      servers: visible.map(({ permissions, ...rest }) => rest),
      serverCount: node.servers.length,
      capacity: await nodeCapacity(node.id),
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const nodeId = params.id;

    // Check if node exists and has servers
    const node = await prisma.node.findUnique({
      where: { id: nodeId },
      include: {
        _count: {
          select: { servers: true }
        }
      }
    });

    if (!node || !canSeeNode(user, node)) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    // Someone who enrolled their own machine retires it themselves; the shared fleet
    // stays an admin's to remove.
    if (!canManageNode(user, node)) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    if (node._count.servers > 0) {
      return NextResponse.json({ 
        error: 'Cannot delete node that has active servers. Please delete the servers first.' 
      }, { status: 400 });
    }

    await prisma.node.delete({
      where: { id: nodeId },
    });

    await writeAudit({ userId: user.userId, action: 'NODE_DELETE', details: { nodeId, name: node.name } });

    return NextResponse.json({ message: 'Node deleted successfully' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to delete node', details: err.message }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const nodeId = params.id;
    const body = await req.json();
    
    // Check if node exists
    const existingNode = await prisma.node.findUnique({
      where: { id: nodeId }
    });

    if (!existingNode || !canSeeNode(user, existingNode)) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    if (!canManageNode(user, existingNode)) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { name, host, port, apiKey, offloadPriority, totalMemory, totalCpu, overcommitRatio, cpuOvercommitRatio, drained } = body;

    /*
     * Overcommit and offload priority decide how hard the scheduler leans on a machine
     * relative to every other one. That is a fleet-wide judgement, so an owner tuning
     * their own node cannot reach it — they set what their machine is and whether it
     * takes work, not how the placement maths treats it against the rest.
     */
    if (!isNodeAdmin(user)) {
      for (const [field, value] of [
        ['overcommitRatio', overcommitRatio],
        ['cpuOvercommitRatio', cpuOvercommitRatio],
        ['offloadPriority', offloadPriority],
      ] as const) {
        if (value !== undefined) {
          return NextResponse.json(
            { error: `Only an administrator can change ${field} on a node.` },
            { status: 403 }
          );
        }
      }
    }

    // 1.0 means "never promise more than the node has". Anything under that would make the node
    // pretend to be smaller than it is, which is what totalMemory is for; 4x is already reckless.
    if (overcommitRatio !== undefined) {
      const ratio = parseFloat(String(overcommitRatio));
      if (!Number.isFinite(ratio) || ratio < 1 || ratio > 4) {
        return NextResponse.json(
          { error: 'Overcommit ratio must be between 1.0 (no overcommit) and 4.0.' },
          { status: 400 }
        );
      }
    }

    // CPU tolerates far more than RAM does, because cpuLimit caps a burst instead of reserving a
    // core — 16x on a busy shared node is aggressive but not absurd.
    if (cpuOvercommitRatio !== undefined) {
      const ratio = parseFloat(String(cpuOvercommitRatio));
      if (!Number.isFinite(ratio) || ratio < 1 || ratio > 16) {
        return NextResponse.json(
          { error: 'CPU overcommit ratio must be between 1.0 (no overcommit) and 16.0.' },
          { status: 400 }
        );
      }
    }

    // 0 is allowed and means "unmeasured" — capacity checks then let anything through. Negative or
    // non-numeric would silently poison every allocation decision made against this node.
    for (const [label, value] of [['Total memory', totalMemory], ['Total CPU', totalCpu]] as const) {
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${label} must be a number of 0 or more.` }, { status: 400 });
      }
    }

    const updatedNode = await prisma.node.update({
      where: { id: nodeId },
      data: {
        /*
         * Draining takes the node out of the scheduler without touching anything on it.
         * Re-draining an already-draining node keeps the original timestamp, so the page
         * can say how long it has been held back rather than resetting the clock on every
         * unrelated save that happens to include the field.
         */
        ...(drained !== undefined
          ? { drainedAt: drained ? (existingNode.drainedAt ?? new Date()) : null }
          : {}),
        ...(overcommitRatio !== undefined ? { overcommitRatio: parseFloat(String(overcommitRatio)) } : {}),
        ...(cpuOvercommitRatio !== undefined ? { cpuOvercommitRatio: parseFloat(String(cpuOvercommitRatio)) } : {}),
        name: name !== undefined ? name : existingNode.name,
        host: host !== undefined ? host : existingNode.host,
        port: port !== undefined ? port : existingNode.port,
        apiKey: apiKey !== undefined ? apiKey : existingNode.apiKey,
        offloadPriority: offloadPriority !== undefined ? offloadPriority : existingNode.offloadPriority,
        totalMemory: totalMemory !== undefined ? Math.round(Number(totalMemory)) : existingNode.totalMemory,
        totalCpu: totalCpu !== undefined ? Math.round(Number(totalCpu)) : existingNode.totalCpu,
      }
    });

    await writeAudit({
      userId: user.userId,
      action: drained !== undefined ? (drained ? 'NODE_DRAIN' : 'NODE_UNDRAIN') : 'NODE_UPDATE',
      details: { nodeId, name: updatedNode.name },
    });

    return NextResponse.json({ message: 'Node updated successfully', node: updatedNode });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to update node', details: err.message }, { status: 500 });
  }
}
