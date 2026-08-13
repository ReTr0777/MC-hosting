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
    const { serverType, mcVersion, createBackup } = await req.json();

    if (!serverType || !mcVersion) {
      return NextResponse.json({ error: 'Missing required parameters: serverType, mcVersion' }, { status: 400 });
    }

    // 1. Update database record for server engine and version
    await prisma.server.update({
      where: { id: server.id },
      data: {
        serverType,
        mcVersion,
      },
    });

    // 2. Dispatch update-engine command to daemon node
    const daemonUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/update-engine`;
    const daemonRes = await fetch(daemonUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${server.node.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serverType,
        mcVersion,
        createBackup: createBackup !== false,
      }),
    });

    if (!daemonRes.ok) {
      const errText = await daemonRes.text();
      throw new Error(`Daemon update-engine failed (${daemonRes.status}): ${errText}`);
    }

    await writeAudit({
      userId: user.userId,
      action: 'SERVER_VERSION_CHANGE',
      details: { serverId: server.id, from: `${server.serverType} ${server.mcVersion}`, to: `${serverType} ${mcVersion}` },
    });

    return NextResponse.json({ message: 'Server engine and version updated successfully' });
  } catch (err: any) {
    console.error('[Web API] Update engine error:', err.message);
    return NextResponse.json({ error: 'Failed to update server engine', details: err.message }, { status: 500 });
  }
}
