import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
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
    return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to export a server' }, { status: 403 });
  }

  try {
    const sourceUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/export`;
    const exportRes = await fetch(sourceUrl, {
      headers: { Authorization: `Bearer ${server.node.apiKey}` },
    });

    if (!exportRes.ok || !exportRes.body) {
      const text = await exportRes.text().catch(() => '');
      return NextResponse.json({ error: `Export failed: HTTP ${exportRes.status}${text ? ` — ${text.slice(0, 200)}` : ''}` }, { status: 502 });
    }

    return new NextResponse(exportRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${server.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.tar.gz"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Export failed' }, { status: 500 });
  }
}
