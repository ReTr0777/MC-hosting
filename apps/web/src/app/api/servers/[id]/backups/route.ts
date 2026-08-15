import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { dispatchNotification } from '@/lib/services/notifications';
import { writeAudit } from '@/lib/audit';
import { pruneBackupsForServer } from '@/lib/servers/backup-retention';

/** The caller's effective role on a server, or null if they have no access to it at all. */
async function roleOn(serverId: string, userId: string, globalRole: string): Promise<string | null> {
  if (globalRole === 'GLOBAL_ADMIN') return 'OWNER';
  const permission = await prisma.serverPermission.findFirst({
    where: { serverId, userId },
    select: { role: true },
  });
  return permission?.role ?? null;
}

/**
 * Retention is a destructive standing order, so it takes more than the OPERATOR role that
 * suffices to take a backup by hand.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = await roleOn(params.id, user.userId, user.globalRole);
  if (role !== 'OWNER' && role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Forbidden: only a server admin or its owner can change the backup retention policy' },
      { status: 403 }
    );
  }

  const body = await request.json();

  // null or '' clears a rule; undefined leaves it as it was.
  const rule = (raw: any, label: string, max: number): number | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const value = parseInt(String(raw), 10);
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      throw new Error(`${label} must be between 1 and ${max}, or blank to disable the rule.`);
    }
    return value;
  };

  const data: any = {};
  try {
    const count = rule(body.count, 'Backups to keep', 365);
    const days = rule(body.days, 'Days to keep backups', 3650);
    const maxTotalMb = rule(body.maxTotalMb, 'Backup storage limit', 10_000_000);
    if (count !== undefined) data.backupRetentionCount = count;
    if (days !== undefined) data.backupRetentionDays = days;
    if (maxTotalMb !== undefined) data.backupMaxTotalMb = maxTotalMb;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  const server = await prisma.server.update({
    where: { id: params.id },
    data,
    select: { backupRetentionCount: true, backupRetentionDays: true, backupMaxTotalMb: true, name: true },
  });

  await writeAudit({
    userId: user.userId,
    action: 'BACKUP_RETENTION_UPDATE',
    details: { serverId: params.id, serverName: server.name, ...data },
  });

  // Apply the new policy immediately rather than waiting for the next backup — a user who
  // just said "keep 3" expects to see three, not to find out at 4am tomorrow.
  const pruned = await pruneBackupsForServer(params.id, { actorUserId: user.userId }).catch(() => null);

  return NextResponse.json({
    retention: {
      count: server.backupRetentionCount,
      days: server.backupRetentionDays,
      maxTotalMb: server.backupMaxTotalMb,
    },
    pruned: pruned?.deleted ?? [],
  });
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    if (!(await roleOn(server.id, user.userId, user.globalRole))) {
      return NextResponse.json({ error: 'Forbidden: no access to this server' }, { status: 403 });
    }

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.request<{ backups: any[] }>(`/servers/${targetContainerId}/backups`);
    return NextResponse.json({
      ...data,
      retention: {
        count: server.backupRetentionCount,
        days: server.backupRetentionDays,
        maxTotalMb: server.backupMaxTotalMb,
      },
    });
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

    // Taking a backup is routine; restoring one overwrites the live world and deleting one is
    // unrecoverable, so those two need the same standing as changing the retention policy.
    const role = await roleOn(server.id, user.userId, user.globalRole);
    const privileged = role === 'OWNER' || role === 'ADMIN';
    if (!role || (!privileged && (action === 'restore' || action === 'delete' || role === 'VIEWER'))) {
      return NextResponse.json({ error: 'Forbidden: insufficient server permissions' }, { status: 403 });
    }

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
      await writeAudit({ userId: user.userId, action: 'BACKUP_RESTORE', details: { serverId: server.id, serverName: server.name, name: body.name } });
      return NextResponse.json(data);
    }

    if (action === 'delete') {
      const data = await daemonClient.request<{ success: boolean }>(`/servers/${targetContainerId}/backups/${body.name}`, {
        method: 'DELETE',
      });
      await writeAudit({ userId: user.userId, action: 'BACKUP_DELETE', details: { serverId: server.id, serverName: server.name, name: body.name } });
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

      await writeAudit({ userId: user.userId, action: 'BACKUP_CREATE', details: { serverId: server.id, serverName: server.name, name: data.backup?.name || body.name } });

      // Retention is applied against the set including the backup just taken, so "keep 5"
      // means the user ends up looking at five, not six.
      const pruned = await pruneBackupsForServer(server.id, { actorUserId: user.userId }).catch(() => null);

      return NextResponse.json({ ...data, pruned: pruned?.deleted ?? [] });
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
