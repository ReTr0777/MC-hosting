import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function DELETE(req: NextRequest, { params }: { params: { id: string; permissionId: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      permissions: { where: { userId: user.userId } },
    },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const currentUserRole = server.permissions[0]?.role;

  if (!isGlobalAdmin && currentUserRole !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin permission required to revoke server access' }, { status: 403 });
  }

  try {
    await prisma.serverPermission.delete({
      where: { id: params.permissionId },
    });
    return NextResponse.json({ success: true, message: 'Permission revoked' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to revoke permission' }, { status: 500 });
  }
}
