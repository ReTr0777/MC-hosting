import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest, hashPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { password, globalRole, maxServers, maxMemoryMb, maxCpu } = await req.json();

  const dataToUpdate: any = {};
  if (password) {
    dataToUpdate.passwordHash = await hashPassword(password);
  }
  if (globalRole) {
    dataToUpdate.globalRole = globalRole;
  }
  // Quota fields: explicit null clears the quota (unlimited); undefined leaves it untouched.
  if (maxServers !== undefined) dataToUpdate.maxServers = maxServers === null ? null : parseInt(maxServers, 10);
  if (maxMemoryMb !== undefined) dataToUpdate.maxMemoryMb = maxMemoryMb === null ? null : parseInt(maxMemoryMb, 10);
  if (maxCpu !== undefined) dataToUpdate.maxCpu = maxCpu === null ? null : parseFloat(maxCpu);

  try {
    const user = await prisma.user.update({
      where: { id: params.id },
      data: dataToUpdate,
      select: {
        id: true,
        email: true,
        username: true,
        globalRole: true,
        maxServers: true,
        maxMemoryMb: true,
        maxCpu: true,
      }
    });
    const changedFields = Object.keys(dataToUpdate).map((f) => (f === 'passwordHash' ? 'password' : f));
    await writeAudit({
      userId: admin.userId,
      action: 'USER_UPDATE',
      details: { targetUserId: params.id, changedFields },
    });
    return NextResponse.json(user);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (admin.userId === params.id) {
    return NextResponse.json({ error: 'You cannot delete yourself' }, { status: 400 });
  }

  try {
    await prisma.user.delete({
      where: { id: params.id }
    });
    await writeAudit({ userId: admin.userId, action: 'USER_DELETE', details: { targetUserId: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
