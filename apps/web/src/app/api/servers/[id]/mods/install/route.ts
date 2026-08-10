import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
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
      return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to install mods' }, { status: 403 });
    }

    const { projectId, versionId, fileUrl, fileName, createBackup } = await req.json();

    if (!projectId || !versionId || !fileUrl || !fileName) {
      return NextResponse.json({ error: 'Missing required parameters: projectId, versionId, fileUrl, fileName' }, { status: 400 });
    }

    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const data = await daemon.installMod(server.id, projectId, versionId, fileUrl, fileName, createBackup !== false);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /mods/install POST error]', err);
    return NextResponse.json({ error: err.message || 'Failed to install mod' }, { status: 500 });
  }
}