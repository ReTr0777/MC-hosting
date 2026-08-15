import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';

/**
 * Backup retention.
 *
 * Scheduled backups are write-only without this: every run adds another full zip of the world
 * and nothing ever removes one, so the node's disk fills up and then *every* server on it
 * starts failing, not just the one with the eager schedule.
 *
 * Three rules, any of which may be off (null). They are evaluated independently and the union
 * of what they condemn is deleted, so "keep 7" and "keep 30 days" together mean "keep at most 7,
 * and drop anything older than 30 days even if that leaves fewer".
 *
 * One safety rail overrides all of them: the newest backup is never deleted. A policy that
 * would otherwise empty the folder — a 1-day rule on a server nobody has backed up this week —
 * leaves the user with something to restore from rather than nothing.
 */

export interface BackupEntry {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface RetentionPolicy {
  /** Keep at most this many backups. */
  count: number | null;
  /** Delete backups older than this many days. */
  days: number | null;
  /** Delete oldest until the whole set fits in this many MB. */
  maxTotalMb: number | null;
}

export function hasRetentionPolicy(policy: RetentionPolicy): boolean {
  return policy.count != null || policy.days != null || policy.maxTotalMb != null;
}

/** Names to delete, oldest first. Pure — the executor below does the talking to the daemon. */
export function selectBackupsToPrune(
  backups: BackupEntry[],
  policy: RetentionPolicy,
  now: Date = new Date()
): string[] {
  if (!hasRetentionPolicy(policy) || backups.length <= 1) return [];

  // Newest first: every rule below is expressed as "how far down this list are you".
  const ordered = [...backups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const condemned = new Set<string>();

  if (policy.count != null && policy.count > 0) {
    for (const backup of ordered.slice(policy.count)) condemned.add(backup.name);
  }

  if (policy.days != null && policy.days > 0) {
    const cutoff = now.getTime() - policy.days * 24 * 60 * 60 * 1000;
    for (const backup of ordered) {
      const created = new Date(backup.createdAt).getTime();
      // An unparseable timestamp is not evidence of age — leave those alone.
      if (Number.isFinite(created) && created < cutoff) condemned.add(backup.name);
    }
  }

  if (policy.maxTotalMb != null && policy.maxTotalMb > 0) {
    const budget = policy.maxTotalMb * 1024 * 1024;
    let used = 0;
    for (const backup of ordered) {
      // Already-condemned backups are not occupying space we need to make room for.
      if (condemned.has(backup.name)) continue;
      used += backup.sizeBytes;
      if (used > budget) condemned.add(backup.name);
    }
  }

  // Never leave the server with nothing to restore from.
  condemned.delete(ordered[0].name);

  return ordered
    .filter((b) => condemned.has(b.name))
    .reverse()
    .map((b) => b.name);
}

export interface PruneResult {
  deleted: string[];
  failed: { name: string; error: string }[];
}

/**
 * Applies the server's retention policy against what the daemon actually holds.
 *
 * Called after every successful backup (manual and scheduled) and by a periodic sweep in the
 * monitor tick, since a `days` rule comes due on its own without anyone taking a new backup.
 */
export async function pruneBackupsForServer(
  serverId: string,
  opts: { actorUserId?: string } = {}
): Promise<PruneResult> {
  const empty: PruneResult = { deleted: [], failed: [] };

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { node: true },
  });
  if (!server) return empty;

  const policy: RetentionPolicy = {
    count: server.backupRetentionCount,
    days: server.backupRetentionDays,
    maxTotalMb: server.backupMaxTotalMb,
  };
  if (!hasRetentionPolicy(policy)) return empty;

  const client = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });
  const target = server.containerId || `process-${server.id}`;

  let backups: BackupEntry[];
  try {
    const data = await client.request<{ backups: BackupEntry[] }>(`/servers/${target}/backups`, {}, 20_000);
    backups = data.backups || [];
  } catch (err: any) {
    console.warn(`[retention] Could not list backups for ${server.name}:`, err?.message);
    return empty;
  }

  const doomed = selectBackupsToPrune(backups, policy);
  const result: PruneResult = { deleted: [], failed: [] };

  for (const name of doomed) {
    try {
      await client.request(`/servers/${target}/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }, 30_000);
      result.deleted.push(name);
    } catch (err: any) {
      result.failed.push({ name, error: err?.message || 'Unknown error' });
    }
  }

  if (result.deleted.length > 0) {
    await writeAudit({
      userId: opts.actorUserId,
      action: 'BACKUP_RETENTION_PRUNE',
      details: {
        serverId: server.id,
        serverName: server.name,
        deleted: result.deleted,
        policy,
      },
    });
  }

  return result;
}
