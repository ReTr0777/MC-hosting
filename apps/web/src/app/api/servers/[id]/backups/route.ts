import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { dispatchNotification } from '@/lib/notifications';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.request<{ backups: any[] }>(`/servers/${targetContainerId}/backups`);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to list backups' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const body = await request.json();
    const action = body.action || 'create';

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;

    if (action === 'restore') {
      const data = await daemonClient.request<{ success: boolean; message: string }>(`/servers/${targetContainerId}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify({ name: body.name }),
      });
      return NextResponse.json(data);
    }

    if (action === 'delete') {
      const data = await daemonClient.request<{ success: boolean }>(`/servers/${targetContainerId}/backups/${body.name}`, {
        method: 'DELETE',
      });
      return NextResponse.json(data);
    }

    // Default action = create
    try {
      const data = await daemonClient.request<{ success: boolean; backup: any }>(`/servers/${targetContainerId}/backups`, {
        method: 'POST',
        body: JSON.stringify({ name: body.name }),
      });

      await dispatchNotification({
        type: 'BACKUP_COMPLETED',
        title: `💾 Backup created for "${server.name}"`,
        body: `Backup "${data.backup?.name || body.name || 'unnamed'}" completed successfully.`,
        fields: [{ name: 'Node', value: server.node.name }],
      });

      return NextResponse.json(data);
    } catch (backupErr: any) {
      await dispatchNotification({
        type: 'BACKUP_FAILED',
        title: `⚠️ Backup failed for "${server.name}"`,
        body: backupErr.message || 'The daemon could not complete the backup.',
        fields: [{ name: 'Node', value: server.node.name }],
      });
      throw backupErr;
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Backup operation failed' }, { status: 500 });
  }
}
