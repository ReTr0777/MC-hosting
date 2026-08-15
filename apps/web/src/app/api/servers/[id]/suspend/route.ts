import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { stopServers } from '@/lib/servers/suspension-actions';

export const dynamic = 'force-dynamic';

/**
 * Suspends or restores a single server.
 *
 * Separate from suspending its owner: a single server can be the problem (a leaking modpack, a
 * pack the host can't legally distribute) without the account being at fault. Global admins
 * only — an owner suspending their own server would just be a confusing way to stop it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  const { suspended, reason } = await req.json();
  if (typeof suspended !== 'boolean') {
    return NextResponse.json({ error: 'suspended must be true or false' }, { status: 400 });
  }

  const existing = await prisma.server.findUnique({ where: { id: params.id }, select: { id: true, name: true } });
  if (!existing) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const server = await prisma.server.update({
    where: { id: params.id },
    data: suspended
      ? { suspendedAt: new Date(), suspendedReason: reason?.trim() || null }
      : { suspendedAt: null, suspendedReason: null },
    select: { id: true, name: true, suspendedAt: true, suspendedReason: true },
  });

  const stopped = suspended ? await stopServers([params.id]) : [];

  await writeAudit({
    userId: admin.userId,
    action: suspended ? 'SERVER_SUSPEND' : 'SERVER_UNSUSPEND',
    details: { serverId: params.id, serverName: server.name, reason: reason || null, wasRunning: stopped.length > 0 },
  });

  return NextResponse.json({
    server,
    message: suspended
      ? `"${server.name}" is suspended${stopped.length ? ' and has been stopped' : ''}. Its files are untouched.`
      : `"${server.name}" can be started again.`,
  });
}
