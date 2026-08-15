import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';
import { nextMemoryTier } from '@/lib/diagnostics/crash-analyzer';

export const dynamic = 'force-dynamic';

/**
 * Executes one of the crash analyser's one-click fixes.
 *
 * The action set is a fixed allow-list decided here, not by the caller and never by the
 * LLM — the analyser only ever names an action id, and this route decides what that means
 * and whether the user may do it.
 */
type QuickFixId = 'increase-memory' | 'restart-server' | 'repair-world';

const MANAGE_ROLES = ['OWNER', 'OPERATOR', 'ADMIN'];

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body?.action as QuickFixId;

  if (!['increase-memory', 'restart-server', 'repair-world'].includes(action)) {
    return NextResponse.json({ error: 'Unknown quick fix action' }, { status: 400 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: { where: { userId: user.userId }, select: { role: true } },
    },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const userRole = server.permissions[0]?.role;
  if (!isGlobalAdmin && !MANAGE_ROLES.includes(userRole || '')) {
    return NextResponse.json({ error: 'Forbidden: Operator access required to apply fixes' }, { status: 403 });
  }

  const client = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });
  const targetContainerId = server.containerId || `process-${server.id}`;

  try {
    if (action === 'increase-memory') {
      return await increaseMemory({ server, user, isGlobalAdmin, client, targetContainerId });
    }

    if (action === 'repair-world') {
      const result = await client.request<any>(`/servers/${server.id}/repair-world`, { method: 'POST' }, 60_000);
      await writeAudit({
        userId: user.userId,
        action: 'WORLD_REPAIR',
        details: { serverId: server.id, serverName: server.name, via: 'crash-analyzer' },
      });
      return NextResponse.json({
        success: true,
        message: result?.message || 'World repair finished. Start the server to check whether it loads.',
      });
    }

    // restart-server — start it if it is down, restart it if it is somehow still up.
    const running = server.status === 'RUNNING' || server.status === 'STARTING';
    if (running) {
      await client.restartServer(targetContainerId);
    } else {
      await client.startServer(targetContainerId, buildServerMeta(server));
    }

    await prisma.server.update({ where: { id: server.id }, data: { status: 'STARTING' } });
    await writeAudit({
      userId: user.userId,
      action: running ? 'SERVER_RESTART' : 'SERVER_START',
      details: { serverId: server.id, serverName: server.name, via: 'crash-analyzer' },
    });

    return NextResponse.json({ success: true, message: running ? 'Restarting the server…' : 'Starting the server…' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Quick fix failed', details: err.message }, { status: 500 });
  }
}

/** The DTO the daemon merges into craftcontrol-meta.json on start — the DB is the source of truth. */
function buildServerMeta(server: any) {
  return {
    serverId: server.id,
    // Carried so a start cannot erase which game this server is.
    game: server.game || undefined,
    gameConfig: server.gameConfig || undefined,
    serverType: server.serverType,
    mcVersion: server.mcVersion,
    modpackSlug: server.modpackSlug || undefined,
    serverPort: server.serverPort,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    eulaAccepted: true,
    executionMode: server.executionMode,
  };
}

async function increaseMemory({
  server,
  user,
  isGlobalAdmin,
  client,
  targetContainerId,
}: {
  server: any;
  user: { userId: string };
  isGlobalAdmin: boolean;
  client: DaemonClient;
  targetContainerId: string;
}) {
  const target = nextMemoryTier(server.memoryMb);

  if (target <= server.memoryMb) {
    return NextResponse.json(
      { error: 'This server is already at the maximum memory tier the panel will set automatically.' },
      { status: 400 }
    );
  }

  // Same quota rules as server creation: only servers this user OWNS count against them.
  if (!isGlobalAdmin) {
    const requester = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { maxMemoryMb: true },
    });

    if (requester?.maxMemoryMb != null) {
      const ownedServers = await prisma.server.findMany({
        where: { permissions: { some: { userId: user.userId, role: 'OWNER' } } },
        select: { id: true, memoryMb: true },
      });
      const projected = ownedServers.reduce(
        (sum: number, s: { id: string; memoryMb: number }) => sum + (s.id === server.id ? target : s.memoryMb),
        0
      );

      if (projected > requester.maxMemoryMb) {
        return NextResponse.json(
          {
            error:
              `Memory quota exceeded: your servers may use at most ${requester.maxMemoryMb} MB in total, ` +
              `and this change would bring them to ${projected} MB.`,
          },
          { status: 403 }
        );
      }
    }
  }

  await prisma.server.update({ where: { id: server.id }, data: { memoryMb: target } });
  await writeAudit({
    userId: user.userId,
    action: 'SERVER_MEMORY_CHANGE',
    details: { serverId: server.id, serverName: server.name, from: server.memoryMb, to: target, via: 'crash-analyzer' },
  });

  // Process-mode servers pick the new limit up from the meta the daemon merges on start.
  // A Docker container has its limit baked in at creation, so it needs a rebuild — which is
  // only safe while the server is down.
  const isDocker = !targetContainerId.startsWith('process-');
  const running = server.status === 'RUNNING' || server.status === 'STARTING';

  let note = `Memory raised from ${server.memoryMb} MB to ${target} MB. It applies the next time the server starts.`;
  let rebuilt = false;

  if (isDocker && !running) {
    try {
      await client.request<any>(
        `/servers/${targetContainerId}/recreate-container`,
        { method: 'POST', body: JSON.stringify({ memoryMb: target, cpuLimit: server.cpuLimit }) },
        120_000
      );
      rebuilt = true;
      note = `Memory raised from ${server.memoryMb} MB to ${target} MB and the container was rebuilt. Start the server when ready.`;
    } catch (err: any) {
      note =
        `Memory raised from ${server.memoryMb} MB to ${target} MB in the panel, but the container could not be rebuilt ` +
        `(${err.message}). The new limit takes effect once the container is recreated.`;
    }
  } else if (isDocker && running) {
    note =
      `Memory raised from ${server.memoryMb} MB to ${target} MB. Stop the server and start it again — the container has to be ` +
      'rebuilt before a Docker memory limit can change.';
  }

  return NextResponse.json({ success: true, memoryMb: target, rebuilt, message: note });
}
