import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: {
        where: { userId: user.userId },
        select: { role: true },
      },
    },
  });

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const userRole = server.permissions[0]?.role;

  if (!isGlobalAdmin && !userRole) {
    return NextResponse.json({ error: 'Forbidden: You do not have access to this server' }, { status: 403 });
  }

  return NextResponse.json({
    server,
    role: isGlobalAdmin ? 'GLOBAL_ADMIN' : userRole,
  });
}
