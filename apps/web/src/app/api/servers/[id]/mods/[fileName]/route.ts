import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function DELETE(req: NextRequest, { params }: { params: { id: string; fileName: string } }) {
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
      return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to uninstall mods' }, { status: 403 });
    }

    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const data = await daemon.uninstallMod(server.id, params.fileName);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /mods/[fileName] DELETE error]', err);
    return NextResponse.json({ error: err.message || 'Failed to uninstall mod' }, { status: 500 });
  }
}