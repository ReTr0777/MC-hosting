import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { quotaSnapshot, quotaViolation, serverOwnerId } from '@/lib/servers/quota';

export const dynamic = 'force-dynamic';

/**
 * Hands a server to a different user.
 *
 * OWNER was previously set once, at creation, and never moved. That made an account effectively
 * permanent: a user who left stranded their servers and went on consuming quota nobody could
 * reclaim, and the only way to re-home a server was to delete and rebuild it.
 *
 * The recipient's quota is checked exactly as if they were creating the server, because from
 * their allowance's point of view that is what is happening.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { targetUserId, keepAccess = true } = await req.json();
  if (!targetUserId) {
    return NextResponse.json({ error: 'targetUserId is required' }, { status: 400 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, memoryMb: true, cpuLimit: true },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const currentOwnerId = await serverOwnerId(server.id);
  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';

  // A server ADMIN can do nearly everything on the server, but giving it away is the owner's
  // call — it moves the quota cost onto somebody else's account.
  if (!isGlobalAdmin && currentOwnerId !== user.userId) {
    return NextResponse.json(
      { error: 'Forbidden: only the current owner can transfer this server' },
      { status: 403 }
    );
  }

  if (targetUserId === currentOwnerId) {
    return NextResponse.json({ error: 'That user already owns this server.' }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, email: true, suspendedAt: true },
  });
  if (!target) return NextResponse.json({ error: 'Target user not found' }, { status: 404 });

  if (target.suspendedAt) {
    return NextResponse.json(
      { error: `${target.username} is suspended and cannot take ownership of a server.` },
      { status: 400 }
    );
  }

  // The recipient pays for this server from here on, so they have to have room for it.
  const snapshot = await quotaSnapshot(target.id);
  const violation = quotaViolation(snapshot, {
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    countsAsNew: true,
  });
  if (violation) {
    return NextResponse.json(
      { error: `${target.username} cannot take this server. ${violation}` },
      { status: 403 }
    );
  }

  // One transaction: a server with two owners, or none, would confuse every quota calculation
  // that follows.
  await prisma.$transaction(async (tx) => {
    if (currentOwnerId) {
      if (keepAccess) {
        // Demoted rather than removed — the previous owner almost always still plays here.
        await tx.serverPermission.updateMany({
          where: { serverId: server.id, userId: currentOwnerId },
          data: { role: 'ADMIN' },
        });
      } else {
        await tx.serverPermission.deleteMany({ where: { serverId: server.id, userId: currentOwnerId } });
      }
    }

    await tx.serverPermission.upsert({
      where: { userId_serverId: { userId: target.id, serverId: server.id } },
      update: { role: 'OWNER' },
      create: { userId: target.id, serverId: server.id, role: 'OWNER' },
    });
  });

  await writeAudit({
    userId: user.userId,
    action: 'SERVER_TRANSFER',
    details: {
      serverId: server.id,
      serverName: server.name,
      fromUserId: currentOwnerId,
      toUserId: target.id,
      toUsername: target.username,
      previousOwnerKeptAccess: keepAccess,
    },
  });

  return NextResponse.json({
    message:
      `"${server.name}" now belongs to ${target.username}` +
      (currentOwnerId
        ? keepAccess
          ? '. The previous owner keeps admin access.'
          : '. The previous owner was removed from the server.'
        : '.'),
  });
}
