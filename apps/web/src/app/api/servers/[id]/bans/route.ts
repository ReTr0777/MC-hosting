import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient, BanAction, BanSnapshot } from '@/lib/daemon-client';
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
    const data = await daemonClient.request<BanSnapshot>(`/servers/${targetContainerId}/bans`);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch ban list' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await resolveServer(params.id);
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { action, username, reason } = (await request.json()) as { action: BanAction; username?: string; reason?: string };

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.request<{ success: boolean; live: boolean; message: string }>(
      `/servers/${targetContainerId}/bans`,
      {
        method: 'POST',
        body: JSON.stringify({ action, username, reason }),
      }
    );

    await writeAudit({
      userId: user.userId,
      action: action === 'unban' ? 'BAN_REMOVE' : 'BAN_ADD',
      details: { serverId: server.id, serverName: server.name, username, reason },
    });

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Ban action failed' }, { status: 500 });
  }
}
