import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient, WhitelistAction, WhitelistSnapshot } from '@/lib/daemon-client';
import { writeAudit } from '@/lib/audit';

async function resolveServer(id: string) {
  return prisma.server.findUnique({
    where: { id },
    include: { node: true },
  });
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await resolveServer(params.id);
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.request<WhitelistSnapshot>(`/servers/${targetContainerId}/whitelist`);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch whitelist' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await resolveServer(params.id);
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { action, username } = (await request.json()) as { action: WhitelistAction; username?: string };

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.request<{ success: boolean; live: boolean; message: string }>(
      `/servers/${targetContainerId}/whitelist`,
      {
        method: 'POST',
        body: JSON.stringify({ action, username }),
      }
    );

    if (action === 'add' || action === 'remove') {
      await writeAudit({
        userId: user.userId,
        action: action === 'remove' ? 'WHITELIST_REMOVE' : 'WHITELIST_ADD',
        details: { serverId: server.id, serverName: server.name, username },
      });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Whitelist action failed' }, { status: 500 });
  }
}
