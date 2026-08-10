import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

/**
 * Global search across servers, audit log entries, and (bounded) live player rosters.
 * Scoped to what the requesting user can actually see — a non-admin only searches
 * servers they have a ServerPermission on.
 */
export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  if (q.length < 2) return NextResponse.json({ servers: [], players: [], auditLogs: [] });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';

  const servers = await prisma.server.findMany({
    where: {
      ...(isGlobalAdmin ? {} : { permissions: { some: { userId: user.userId } } }),
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, description: true, status: true },
    take: 10,
  });

  const auditLogs = isGlobalAdmin
    ? await prisma.auditLog.findMany({
        where: { OR: [{ action: { contains: q, mode: 'insensitive' } }, { details: { contains: q, mode: 'insensitive' } }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, action: true, details: true, createdAt: true },
        take: 10,
      })
    : [];

  // Live player search — bounded to RUNNING servers the user can see, capped to avoid a
  // daemon fan-out storm on every keystroke.
  const runningServers = await prisma.server.findMany({
    where: {
      status: 'RUNNING',
      ...(isGlobalAdmin ? {} : { permissions: { some: { userId: user.userId } } }),
    },
    include: { node: true },
    take: 15,
  });

  const playerHits: Array<{ username: string; serverId: string; serverName: string }> = [];
  await Promise.all(
    runningServers.map(async (server) => {
      try {
        const daemon = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
        const targetContainerId = server.containerId || `process-${server.id}`;
        const data = await daemon.request<{ players: Array<{ username: string }> }>(`/servers/${targetContainerId}/players`);
        for (const p of data.players || []) {
          if (p.username.toLowerCase().includes(q.toLowerCase())) {
            playerHits.push({ username: p.username, serverId: server.id, serverName: server.name });
          }
        }
      } catch {
        // Node unreachable — skip silently, this is best-effort
      }
    })
  );

  return NextResponse.json({ servers, players: playerHits.slice(0, 10), auditLogs });
}
