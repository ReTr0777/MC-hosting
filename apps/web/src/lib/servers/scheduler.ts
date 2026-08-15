import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { dispatchNotification } from '@/lib/services/notifications';
import { isDue, nextRun } from '@/lib/servers/cron';
import { serverStartBlock } from '@/lib/servers/suspension';
import { pruneBackupsForServer } from '@/lib/servers/backup-retention';

/**
 * Scheduled task execution.
 *
 * This used to live in the daemon, which only polled when it had DATABASE_URL — and it
 * never did, so schedules were accepted by the UI and then never ran. The panel always
 * has database access, so it owns the clock now and drives the daemon over HTTP.
 */

export const SCHEDULE_ACTIONS = ['BACKUP', 'COMMAND', 'START', 'RESTART', 'STOP'] as const;
export type ScheduleAction = typeof SCHEDULE_ACTIONS[number];

export interface ScheduleRunResult {
  scheduleId: string;
  name: string;
  action: string;
  ok: boolean;
  message: string;
}

type ScheduleWithServer = {
  id: string;
  name: string;
  serverId: string;
  cronExpression: string;
  actionType: string;
  payload: string | null;
  lastRunAt: Date | null;
  server: {
    id: string;
    name: string;
    containerId: string | null;
    node: { host: string; port: number; apiKey: string; name: string };
  };
};

function targetFor(server: ScheduleWithServer['server']): string {
  return server.containerId || `process-${server.id}`;
}

/** Runs one schedule's action against its node. Throws on failure. */
export async function executeSchedule(schedule: ScheduleWithServer): Promise<string> {
  const { server } = schedule;
  const client = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });
  const target = targetFor(server);

  switch (schedule.actionType) {
    case 'BACKUP': {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const name = `auto_${schedule.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${stamp}`;
      await client.request(`/servers/${target}/backups`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }, 300_000);

      // Pruning is what stops a nightly schedule from filling the node's disk. It runs after
      // the new backup exists, so the retention count is measured against the set the user
      // will actually see. A pruning failure must not mark the backup itself as failed.
      const pruned = await pruneBackupsForServer(server.id).catch(() => null);
      const suffix = pruned?.deleted.length ? `, ${pruned.deleted.length} old backup(s) pruned` : '';
      return `Backup "${name}" created${suffix}`;
    }

    case 'COMMAND': {
      if (!schedule.payload) throw new Error('Schedule has no command to run');
      await client.request(`/servers/${server.id}/command`, {
        method: 'POST',
        body: JSON.stringify({ command: schedule.payload }),
      });
      return `Ran console command: ${schedule.payload}`;
    }

    case 'START': {
      const block = await serverStartBlock(server.id);
      if (block) throw new Error(block);
      await client.startServer(target);
      await prisma.server.update({ where: { id: server.id }, data: { status: 'STARTING' } }).catch(() => {});
      return 'Server start requested';
    }

    case 'STOP': {
      await client.stopServer(target);
      await prisma.server.update({ where: { id: server.id }, data: { status: 'STOPPING' } }).catch(() => {});
      return 'Server stop requested';
    }

    case 'RESTART': {
      const block = await serverStartBlock(server.id);
      if (block) throw new Error(block);
      await client.restartServer(target);
      await prisma.server.update({ where: { id: server.id }, data: { status: 'STARTING' } }).catch(() => {});
      return 'Server restart requested';
    }

    default:
      throw new Error(`Unknown schedule action "${schedule.actionType}"`);
  }
}

/**
 * Executes a schedule and records the outcome. Used by both the timer and the
 * manual "run now" button, so a manual run updates lastRunAt the same way.
 */
export async function runSchedule(
  schedule: ScheduleWithServer,
  opts: { notify?: boolean } = {}
): Promise<ScheduleRunResult> {
  const now = new Date();

  try {
    const message = await executeSchedule(schedule);

    await prisma.serverSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: now, nextRunAt: nextRun(schedule.cronExpression, now) },
    }).catch(() => {});

    if (opts.notify) {
      await dispatchNotification({
        type: 'SCHEDULE_RAN',
        title: `⏰ "${schedule.name}" ran on ${schedule.server.name}`,
        body: message,
        fields: [
          { name: 'Action', value: schedule.actionType },
          { name: 'Schedule', value: schedule.cronExpression },
        ],
      });
    }

    return { scheduleId: schedule.id, name: schedule.name, action: schedule.actionType, ok: true, message };
  } catch (err: any) {
    const message = err?.message || 'Unknown error';

    // Still stamp lastRunAt: without it a failing schedule retries every tick
    // for the whole matching minute and spams the webhook.
    await prisma.serverSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: now, nextRunAt: nextRun(schedule.cronExpression, now) },
    }).catch(() => {});

    if (opts.notify) {
      await dispatchNotification({
        type: 'SCHEDULE_FAILED',
        title: `⚠️ "${schedule.name}" failed on ${schedule.server.name}`,
        body: message,
        fields: [
          { name: 'Action', value: schedule.actionType },
          { name: 'Node', value: schedule.server.node.name },
        ],
      });
    }

    return { scheduleId: schedule.id, name: schedule.name, action: schedule.actionType, ok: false, message };
  }
}

/** Fires every enabled schedule whose cron expression matches the current minute. */
export async function runDueSchedules(now: Date = new Date()): Promise<ScheduleRunResult[]> {
  let schedules: ScheduleWithServer[];

  try {
    schedules = (await prisma.serverSchedule.findMany({
      where: { isEnabled: true },
      include: { server: { include: { node: true } } },
    })) as unknown as ScheduleWithServer[];
  } catch {
    // Table missing on a panel that hasn't run `prisma db push` yet
    return [];
  }

  const due = schedules.filter((s) => isDue(s.cronExpression, s.lastRunAt, now));
  if (due.length === 0) return [];

  // Sequential on purpose: two schedules on one server (say STOP then BACKUP) must
  // not race each other.
  const results: ScheduleRunResult[] = [];
  for (const schedule of due) {
    results.push(await runSchedule(schedule, { notify: true }));
  }
  return results;
}
