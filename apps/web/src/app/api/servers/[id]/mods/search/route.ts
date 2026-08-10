import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const query = url.searchParams.get('q') || '';
    const gameVersion = url.searchParams.get('gameVersion') || undefined;
    const loader = url.searchParams.get('loader') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const projectType = url.searchParams.get('projectType') as 'mod' | 'modpack' | undefined;

    if (!query.trim()) {
      return NextResponse.json({ error: 'Search query is required' }, { status: 400 });
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

    if (!isGlobalAdmin && !userRole) {
      return NextResponse.json({ error: 'Forbidden: No permission for this server' }, { status: 403 });
    }

    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const data = await daemon.searchMods(server.id, query, { gameVersion, loader, limit, offset, projectType });
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /mods/search GET error]', err);
    return NextResponse.json({ error: err.message || 'Failed to search mods' }, { status: 500 });
  }
}