import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';
import { quotaSnapshot, quotaViolation, serverOwnerId } from '@/lib/servers/quota';
import { nodeCapacity, capacityViolation } from '@/lib/servers/node-capacity';

export const dynamic = 'force-dynamic';

/** A running server holds its allocation, so resizing has to wait for it to stop. */
const BUSY_STATUSES = ['RUNNING', 'STARTING'];

const MIN_MEMORY_MB = 512;

/** The tighter of two ceilings, where null means "this one doesn't constrain anything". */
function lower(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

async function loadServer(id: string) {
  return prisma.server.findUnique({ where: { id }, include: { node: true } });
}

/**
 * Resizing spends the owner's quota, so only the owner (or a global admin) may do it —
 * a server ADMIN can rename and operate the server but cannot enlarge someone else's bill.
 */
async function authorise(req: NextRequest, serverId: string) {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const server = await loadServer(serverId);
  if (!server) return { error: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const permission = await prisma.serverPermission.findFirst({
    where: { serverId, userId: user.userId },
    select: { role: true },
  });

  if (!isGlobalAdmin && permission?.role !== 'OWNER') {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: only the server owner can change its resources' },
        { status: 403 }
      ),
    };
  }

  return { user, server };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorise(req, params.id);
  if (auth.error) return auth.error;
  const { server } = auth;

  // The ceiling belongs to whoever owns the server, not to the admin who happens to be looking.
  const ownerId = await serverOwnerId(server.id);
  const snapshot = ownerId
    ? await quotaSnapshot(ownerId, { excludeServerId: server.id })
    : null;

  // Two independent ceilings — what the owner is allowed and what the machine has left. The
  // picker must offer the lower of the two, or it will offer sizes the save then rejects.
  const capacity = await nodeCapacity(server.nodeId, { excludeServerId: server.id });

  return NextResponse.json({
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    executionMode: server.executionMode,
    status: server.status,
    isBusy: BUSY_STATUSES.includes(server.status),
    minMemoryMb: MIN_MEMORY_MB,
    memoryCeiling: lower(snapshot?.memoryCeiling ?? null, capacity?.freeMemoryMb ?? null),
    cpuCeiling: lower(snapshot?.cpuCeiling ?? null, capacity?.freeCpu ?? null),
    quotaMemoryCeiling: snapshot?.memoryCeiling ?? null,
    nodeName: server.node.name,
    nodeFreeMemoryMb: capacity?.freeMemoryMb ?? null,
    nodeFreeCpu: capacity?.freeCpu ?? null,
    // Docker fixes limits at container creation, so the container is rebuilt around the volume.
    requiresRebuild: server.executionMode === 'CONTAINER',
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorise(req, params.id);
  if (auth.error) return auth.error;
  const { user, server } = auth;

  const body = await req.json();
  const memoryMb = parseInt(String(body.memoryMb), 10);
  const cpuLimit = parseFloat(String(body.cpuLimit));

  if (!Number.isFinite(memoryMb) || memoryMb < MIN_MEMORY_MB) {
    return NextResponse.json({ error: `Memory must be at least ${MIN_MEMORY_MB} MB` }, { status: 400 });
  }
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) {
    return NextResponse.json({ error: 'CPU limit must be greater than zero' }, { status: 400 });
  }

  if (BUSY_STATUSES.includes(server.status)) {
    return NextResponse.json(
      { error: 'Stop the server before changing its resources.' },
      { status: 409 }
    );
  }

  if (memoryMb === server.memoryMb && cpuLimit === server.cpuLimit) {
    return NextResponse.json({ server, unchanged: true });
  }

  const ownerId = await serverOwnerId(server.id);
  if (ownerId) {
    // The server's own current allocation is excluded, so shrinking is never blocked by the
    // space the server is already taking up.
    const snapshot = await quotaSnapshot(ownerId, { excludeServerId: server.id });
    const violation = quotaViolation(snapshot, { memoryMb, cpuLimit, countsAsNew: false });
    if (violation) return NextResponse.json({ error: violation }, { status: 403 });
  }

  // Being allowed to ask for it is not the same as the node having it.
  const capacity = await nodeCapacity(server.nodeId, { excludeServerId: server.id });
  const overCapacity = capacity && capacityViolation(capacity, { memoryMb, cpuLimit });
  if (overCapacity) return NextResponse.json({ error: overCapacity }, { status: 507 });

  // A Docker container's memory and CPU limits are immutable, so the container is rebuilt.
  // The named volume survives the rebuild, and the daemon syncs it to the host first.
  let containerId = server.containerId;
  let rebuilt = false;
  if (server.executionMode === 'CONTAINER' && server.containerId) {
    try {
      const client = new DaemonClient({
        host: server.node.host,
        port: server.node.port,
        apiKey: server.node.apiKey,
      });
      const result = await client.request<any>(
        `/servers/${server.containerId}/recreate-container`,
        { method: 'POST', body: JSON.stringify({ memoryMb, cpuLimit }) },
        120_000 // Syncing the volume to the host and rebuilding can take a while on a big pack
      );
      if (result?.containerId) containerId = result.containerId;
      rebuilt = !result?.skipped;
    } catch (err: any) {
      return NextResponse.json(
        { error: `Could not rebuild the container: ${err.message}` },
        { status: 502 }
      );
    }
  }
  // PROCESS-mode servers need no daemon call: the panel sends memoryMb and cpuLimit with every
  // start request, which is also what rewrites craftcontrol-meta.json on the node.

  const updated = await prisma.server.update({
    where: { id: server.id },
    data: { memoryMb, cpuLimit, ...(containerId ? { containerId } : {}) },
  });

  await writeAudit({
    userId: user.userId,
    action: 'SERVER_RESIZE',
    details: {
      serverId: server.id,
      from: { memoryMb: server.memoryMb, cpuLimit: server.cpuLimit },
      to: { memoryMb, cpuLimit },
      rebuilt,
    },
  });

  return NextResponse.json({
    server: updated,
    rebuilt,
    message: rebuilt
      ? 'Resources updated and the container was rebuilt. Start the server when ready.'
      : 'Resources updated. They apply the next time the server starts.',
  });
}
