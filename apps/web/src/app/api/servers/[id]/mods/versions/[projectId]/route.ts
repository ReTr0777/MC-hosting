import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

export async function GET(req: NextRequest, { params }: { params: { id: string; projectId: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const gameVersion = url.searchParams.get('gameVersion') || undefined;
    const loader = url.searchParams.get('loader') || undefined;

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

    const data = await daemon.getModVersions(server.id, params.projectId, { gameVersion, loader });
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /mods/versions GET error]', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch mod versions' }, { status: 500 });
  }
}