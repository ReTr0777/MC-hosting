import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true },
  });

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  try {
    const daemonUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/repair-world`;
    const daemonRes = await fetch(daemonUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${server.node.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await daemonRes.json();
    if (!daemonRes.ok) {
      throw new Error(data.error || data.details || 'Daemon repair failed');
    }

    await writeAudit({ userId: user.userId, action: 'WORLD_REPAIR', details: { serverId: server.id, serverName: server.name } });

    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[Web API] Repair world error:', err.message);
    return NextResponse.json({ error: 'Failed to repair world settings', details: err.message }, { status: 500 });
  }
}
