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

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { name, description } = body;

  if (name !== undefined && !String(name).trim()) {
    return NextResponse.json({ error: 'Server name cannot be empty' }, { status: 400 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      permissions: { where: { userId: user.userId } },
    },
  });

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const currentUserRole = server.permissions[0]?.role;

  if (!isGlobalAdmin && currentUserRole !== 'OWNER' && currentUserRole !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required to rename this server' }, { status: 403 });
  }

  const data: { name?: string; description?: string | null } = {};
  if (name !== undefined) data.name = String(name).trim().slice(0, 100);
  if (description !== undefined) data.description = description ? String(description).trim().slice(0, 500) : null;

  const updated = await prisma.server.update({
    where: { id: params.id },
    data,
  });

  return NextResponse.json({ server: updated });
}
