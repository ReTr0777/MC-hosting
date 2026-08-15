import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { ownedServerIds, stopServers } from '@/lib/servers/suspension-actions';

export const dynamic = 'force-dynamic';

/**
 * Suspends or restores a user account.
 *
 * The alternative to this has always been deletion, which takes their worlds with it. A
 * suspension is the reversible version: they cannot sign in and their servers cannot run, but
 * nothing is destroyed and lifting it is one more call to this endpoint.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  if (admin.userId === params.id) {
    return NextResponse.json({ error: 'You cannot suspend your own account.' }, { status: 400 });
  }

  const { suspended, reason } = await req.json();
  if (typeof suspended !== 'boolean') {
    return NextResponse.json({ error: 'suspended must be true or false' }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: params.id },
    select: { id: true, username: true, globalRole: true, suspendedAt: true },
  });
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Locking out the last administrator would leave nobody able to undo it.
  if (suspended && target.globalRole === 'GLOBAL_ADMIN') {
    const activeAdmins = await prisma.user.count({
      where: { globalRole: 'GLOBAL_ADMIN', suspendedAt: null },
    });
    if (activeAdmins <= 1) {
      return NextResponse.json(
        { error: 'This is the last active administrator — suspending it would lock everyone out.' },
        { status: 400 }
      );
    }
  }

  const user = await prisma.user.update({
    where: { id: params.id },
    data: suspended
      ? { suspendedAt: new Date(), suspendedReason: reason?.trim() || null }
      : { suspendedAt: null, suspendedReason: null },
    select: { id: true, username: true, suspendedAt: true, suspendedReason: true },
  });

  // Suspension blocks starts; anything already up has to be brought down explicitly, or the
  // suspension appears to do nothing until the server next stops on its own.
  let stopped: string[] = [];
  if (suspended) {
    stopped = await stopServers(await ownedServerIds(params.id));
  }

  await writeAudit({
    userId: admin.userId,
    action: suspended ? 'USER_SUSPEND' : 'USER_UNSUSPEND',
    details: { targetUserId: params.id, username: target.username, reason: reason || null, stopped },
  });

  return NextResponse.json({
    user,
    stopped,
    message: suspended
      ? `${user.username} is suspended${stopped.length ? `, and ${stopped.length} running server(s) were stopped` : ''}.`
      : `${user.username} can sign in again.`,
  });
}
