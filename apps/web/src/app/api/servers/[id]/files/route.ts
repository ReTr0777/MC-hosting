import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const pathParam = url.searchParams.get('path') || '';

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

    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const data = await daemon.listFiles(server.id, pathParam);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /files GET error]', err);
    return NextResponse.json({ error: err.message || 'Failed to list server files' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to modify files' }, { status: 403 });
  }

  const { action, path: relPath, name, oldPath, newPath } = await req.json();

  const daemon = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });

  try {
    if (action === 'create-folder') {
      const res = await daemon.createFolder(server.id, relPath || '', name);
      return NextResponse.json(res);
    } else if (action === 'rename') {
      const res = await daemon.renameFile(server.id, oldPath, newPath);
      return NextResponse.json(res);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'File action failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
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

  if (!isGlobalAdmin && (!userRole || userRole === 'VIEWER')) {
    return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to delete files' }, { status: 403 });
  }

  try {
    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const res = await daemon.deleteFile(server.id, relPath);
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete file' }, { status: 500 });
  }
}
