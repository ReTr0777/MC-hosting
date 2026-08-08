import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      permissions: {
        include: {
          user: {
            select: { id: true, username: true, email: true, globalRole: true },
          },
        },
      },
    },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const currentUserRole = server.permissions.find((p: { userId: string; role: string }) => p.userId === user.userId)?.role;

  if (!isGlobalAdmin && currentUserRole !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required to view server permissions' }, { status: 403 });
  }

  return NextResponse.json({ permissions: server.permissions });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { targetUserId, role } = await req.json();

  if (!targetUserId || !role || !['VIEWER', 'OPERATOR', 'ADMIN'].includes(role)) {
    return NextResponse.json({ error: 'Missing or invalid parameters: targetUserId and role (VIEWER, OPERATOR, ADMIN)' }, { status: 400 });
  }

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
    return NextResponse.json({ error: 'Forbidden: Admin permission required to manage server privileges' }, { status: 403 });
  }

  try {
    // Automatically alter PostgreSQL enum type if OPERATOR value is missing in existing database
    await prisma.$executeRawUnsafe(`ALTER TYPE "ServerRole" ADD VALUE IF NOT EXISTS 'OPERATOR';`).catch((e) => {
      console.warn('[Permissions API] ALTER TYPE warning:', e.message);
    });

    const permission = await prisma.serverPermission.upsert({
      where: {
        userId_serverId: {
          userId: targetUserId,
          serverId: params.id,
        },
      },
      update: { role },
      create: {
        userId: targetUserId,
        serverId: params.id,
        role,
      },
      include: {
        user: {
          select: { id: true, username: true, email: true },
        },
      },
    });

    return NextResponse.json({ permission });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update server permission' }, { status: 500 });
  }
}
