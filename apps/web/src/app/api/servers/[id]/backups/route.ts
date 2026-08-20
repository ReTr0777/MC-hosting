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
      const data = await daemonClient.request<{ success: boolean; message: string }>(
        `/servers/${targetContainerId}/backups/restore`,
        { method: 'POST', body: JSON.stringify({ name: body.name }) },
        DaemonClient.BACKUP_TIMEOUT_MS
      );
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
      /*
       * The daemon starts the archive and answers straight away. It cannot do otherwise:
       * Cloudflare abandons an origin request after 100 seconds and returns 524, so a
       * backup of any size reported as a failure while it was quietly succeeding.
       */
      const data = await daemonClient.request<{ started: boolean; job: { name: string } }>(
        `/servers/${targetContainerId}/backups`,
        { method: 'POST', body: JSON.stringify({ name: body.name }) },
        DaemonClient.DEFAULT_TIMEOUT_MS
      );

      await writeAudit({
        userId: user.userId,
        action: 'BACKUP_CREATE',
        details: { serverId: server.id, serverName: server.name, name: data.job?.name || body.name },
      });

      // Notifying and pruning belong to the finished archive, not to the request that
      // asked for it, so they follow the job rather than the response.
      void awaitBackupThenFinish(server, daemonClient, targetContainerId, data.job?.name, user.userId);

      return NextResponse.json({ ...data, pending: true });
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

/**
 * Waits for a background backup to finish, then notifies and prunes.
 *
 * These used to happen inline, which worked only while the request stayed open for the
 * whole compression. It cannot: Cloudflare gives an origin 100 seconds. So the request
 * returns as soon as the daemon has started, and this follows the job instead.
 *
 * The daemon is the source of truth throughout — this only watches. If the panel restarts
 * mid-backup the archive still completes and still appears in the listing; what is lost is
 * the notification and that round of pruning, which the next backup will do anyway. Losing
 * a notification is an acceptable price for not losing the backup.
 */
async function awaitBackupThenFinish(
  server: { id: string; name: string; node: { name: string } },
  daemonClient: DaemonClient,
  target: string,
  jobName: string | undefined,
  actorUserId: string
): Promise<void> {
  const deadline = Date.now() + DaemonClient.BACKUP_TIMEOUT_MS;
  const POLL_MS = 10_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    let listing: { job?: { state: string; error?: string } | null };
    try {
      listing = await daemonClient.request(`/servers/${target}/backups`, {}, 30_000);
    } catch {
      // A poll that fails says nothing about the backup — the daemon may simply be busy
      // writing it. Keep watching until the deadline rather than declaring anything.
      continue;
    }

    if (listing.job?.state === 'running') continue;

    if (listing.job?.state === 'failed') {
      await dispatchNotification({
        type: 'BACKUP_COMPLETED',
        title: `⚠️ Backup failed for "${server.name}"`,
        body: listing.job.error || 'The node reported a failure while writing the archive.',
        fields: [{ name: 'Node', value: server.node.name }],
      }).catch(() => {});
      return;
    }

    // No job left: the archive is written and in the listing.
    await dispatchNotification({
      type: 'BACKUP_COMPLETED',
      title: `💾 Backup created for "${server.name}"`,
      body: `Backup "${jobName || 'unnamed'}" completed successfully.`,
      fields: [{ name: 'Node', value: server.node.name }],
    }).catch(() => {});

    // Retention is applied against the set including the backup just taken, so "keep 5"
    // means the user ends up looking at five, not six.
    await pruneBackupsForServer(server.id, { actorUserId }).catch(() => null);
    return;
  }
}
