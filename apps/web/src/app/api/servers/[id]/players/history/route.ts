import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

/**
 * Everyone ever seen on this server, with playtime totals.
 *
 * Totals come from the denormalised counters on ServerPlayer rather than a sum over the session
 * table, so this stays fast on a server with years of history. The currently-open session isn't
 * included — it only exists in the daemon's memory until the player disconnects — which is why the
 * live roster is a separate call.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { permissions: { where: { userId: user.userId } } },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  if (!isGlobalAdmin && !server.permissions[0]?.role) {
    return NextResponse.json({ error: 'Forbidden: No permission for this server' }, { status: 403 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 100, 500);

  const players = await prisma.serverPlayer.findMany({
    where: { serverId: server.id },
    orderBy: { playtimeSeconds: 'desc' },
    take: limit,
    select: {
      id: true,
      username: true,
      uuid: true,
      firstSeenAt: true,
      lastSeenAt: true,
      playtimeSeconds: true,
      sessionCount: true,
    },
  });

  const totals = await prisma.serverPlayer.aggregate({
    where: { serverId: server.id },
    _count: { id: true },
    _sum: { playtimeSeconds: true, sessionCount: true },
  });

  const recentSessions = await prisma.playerSession.findMany({
    where: { serverId: server.id },
    orderBy: { leftAt: 'desc' },
    take: 25,
    select: {
      id: true,
      joinedAt: true,
      leftAt: true,
      seconds: true,
      player: { select: { username: true } },
    },
  });

  return NextResponse.json({
    players: players.map((p) => ({ ...p, avatarUrl: `https://mc-heads.net/avatar/${p.username}/64` })),
    recentSessions: recentSessions.map((s) => ({
      id: s.id,
      username: s.player.username,
      joinedAt: s.joinedAt,
      leftAt: s.leftAt,
      seconds: s.seconds,
    })),
    totals: {
      uniquePlayers: totals._count.id,
      playtimeSeconds: totals._sum.playtimeSeconds ?? 0,
      sessions: totals._sum.sessionCount ?? 0,
    },
  });
}
