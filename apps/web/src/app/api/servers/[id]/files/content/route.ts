import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const relPath = url.searchParams.get('path');

  if (!relPath) return NextResponse.json({ error: 'Missing path query parameter' }, { status: 400 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: { where: { userId: user.userId } },
    },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const userRole = server.permissions[0]?.role;

  if (!isGlobalAdmin && !userRole) {
    return NextResponse.json({ error: 'Forbidden: No permission for this server' }, { status: 403 });
  }

  try {
    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const fileData = await daemon.readFile(server.id, relPath);
    return NextResponse.json(fileData);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to read file content' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { path: relPath, content } = await req.json();

  if (!relPath || content === undefined) {
    return NextResponse.json({ error: 'Missing path or content' }, { status: 400 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: { where: { userId: user.userId } },
    },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const userRole = server.permissions[0]?.role;

  if (!isGlobalAdmin && (!userRole || userRole === 'VIEWER')) {
    return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to write file' }, { status: 403 });
  }

  try {
    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const res = await daemon.writeFile(server.id, relPath, content);
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to write file content' }, { status: 500 });
  }
}
