import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/daemon-client';
import { dispatchNotification } from '@/lib/notifications';
import { monitorKey } from '@/lib/monitor-auth';
import { runDueSchedules } from '@/lib/scheduler';
import { evaluateSleep, requestSleep } from '@/lib/sleep';

export const dynamic = 'force-dynamic';

/**
 * A server that was just asked to start hasn't necessarily spawned yet. Ignore
 * liveness mismatches inside this window so a normal boot isn't reported as a crash.
 */
const STARTUP_GRACE_MS = 120_000;

interface BulkStatus {
  statuses: Record<
    string,
    {
      running: boolean;
      mode: string;
      sleeping?: boolean;
      players?: number | null;
      maxPlayers?: number | null;
    }
  >;
}

export async function POST(request: NextRequest) {
  if (request.headers.get('x-monitor-key') !== monitorKey()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const summary = {
    nodesChecked: 0,
    serversChecked: 0,
    events: [] as string[],
    schedulesRun: [] as string[],
  };

  try {
    const nodes = await prisma.node.findMany({ include: { servers: true } });

    for (const node of nodes) {
      summary.nodesChecked++;
      const client = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

      let nodeOnline = false;
      let health: any = null;
      try {
        health = await client.getHealth();
        nodeOnline = health.status === 'ok' || health.dockerAvailable;
      } catch (err) {
        nodeOnline = false;
      }

      // ── Node up/down transitions ──
      if (nodeOnline !== node.isOnline) {
        summary.events.push(`${node.name}: ${nodeOnline ? 'ONLINE' : 'OFFLINE'}`);
        await dispatchNotification({
          type: nodeOnline ? 'NODE_ONLINE' : 'NODE_OFFLINE',
          title: nodeOnline ? `🟢 Node "${node.name}" is back online` : `🔴 Node "${node.name}" is unreachable`,
          body: nodeOnline
            ? `The daemon at ${node.host}:${node.port} is responding again.`
            : `The daemon at ${node.host}:${node.port} stopped responding. Servers on this node cannot be managed until it returns.`,
          fields: [{ name: 'Servers on node', value: String(node.servers.length) }],
        });
      }

      const primaryDisk = health?.diskUsage?.filter((d: any) => d.total > 0).sort((a: any, b: any) => b.total - a.total)[0];

      await prisma.node.update({
        where: { id: node.id },
        data: nodeOnline
          ? {
              isOnline: true,
              ...(health?.memoryUsage?.total ? { totalMemory: health.memoryUsage.total } : {}),
              liveCpuUsage: health?.cpuUsage ?? null,
              liveRamUsed: health?.memoryUsage?.used ?? null,
              liveRamTotal: health?.memoryUsage?.total ?? null,
              liveDiskUsed: primaryDisk?.used ?? null,
              liveDiskTotal: primaryDisk?.total ?? null,
              liveCpuModel: health?.cpuModel ?? null,
              liveCpuCores: health?.cpuCores ?? null,
              liveOsDistro: health?.osInfo?.distro ?? null,
              liveCpuTemp: health?.cpuTemp ?? null,
              liveLastSeenAt: new Date(),
            }
          : { isOnline: false },
      }).catch(() => {});

      if (!nodeOnline || node.servers.length === 0) continue;

      // ── Reconcile server state against what is actually running ──
      let bulk: BulkStatus;
      try {
        const ids = node.servers.map((s) => s.id).join(',');
        bulk = await client.request<BulkStatus>(`/servers/statuses?ids=${encodeURIComponent(ids)}`);
      } catch (err) {
        continue;
      }

      for (const server of node.servers) {
        summary.serversChecked++;
        const live = bulk.statuses?.[server.id];
        if (!live) continue;

        // ── Sleeping servers first ──
        // A sleeping server is deliberately not running, so it must be handled before
        // crash detection or every nap would be reported as a crash.
        if (live.sleeping) {
          if (server.status !== 'SLEEPING') {
            summary.events.push(`${server.name}: SLEEPING`);
            await prisma.server.update({
              where: { id: server.id },
              data: { status: 'SLEEPING', sleepEmptySince: null, lastSleptAt: new Date() },
            }).catch(() => {});
          }
          continue;
        }

        // Woken by a joining player: the daemon started it without the panel asking
        if (server.status === 'SLEEPING' && live.running) {
          summary.events.push(`${server.name}: WOKE`);
          await prisma.server.update({
            where: { id: server.id },
            data: { status: 'RUNNING', sleepEmptySince: null, lastWokeAt: new Date() },
          }).catch(() => {});
          await dispatchNotification({
            type: 'SERVER_WOKE',
            title: `☀️ "${server.name}" woke up`,
            body: 'A player tried to join, so the server was started automatically.',
            fields: [{ name: 'Node', value: node.name }],
          });
          continue;
        }

        // Daemon restarted and lost its listeners; the port is unheld. Re-sleep rather
        // than silently leaving the server unreachable.
        if (server.status === 'SLEEPING' && !live.running) {
          if (server.sleepEnabled) {
            try {
              await requestSleep(node, server);
              summary.events.push(`${server.name}: RE-SLEPT`);
            } catch (err: any) {
              summary.events.push(`${server.name}: re-sleep failed (${err.message})`);
              await prisma.server.update({
                where: { id: server.id },
                data: { status: 'OFFLINE' },
              }).catch(() => {});
            }
          } else {
            await prisma.server.update({
              where: { id: server.id },
              data: { status: 'OFFLINE' },
            }).catch(() => {});
          }
          continue;
        }

        const dbSaysUp = server.status === 'RUNNING';
        const recentlyTouched = Date.now() - new Date(server.updatedAt).getTime() < STARTUP_GRACE_MS;

        // Crash: we believed it was up, it isn't, and nobody just asked it to change
        if (dbSaysUp && !live.running && !recentlyTouched) {
          summary.events.push(`${server.name}: CRASHED`);
          await prisma.server.update({ where: { id: server.id }, data: { status: 'ERROR' } }).catch(() => {});
          await dispatchNotification({
            type: 'SERVER_CRASHED',
            title: `💥 "${server.name}" stopped unexpectedly`,
            body: `The server was running but its ${live.mode === 'docker' ? 'container' : 'process'} is gone. Nobody issued a stop from the panel — check the console for a crash report.`,
            fields: [
              { name: 'Node', value: node.name },
              { name: 'Version', value: `${server.serverType} ${server.mcVersion}` },
            ],
          });
          continue;
        }

        // Clean shutdown finished
        if (server.status === 'STOPPING' && !live.running) {
          await prisma.server.update({ where: { id: server.id }, data: { status: 'OFFLINE' } }).catch(() => {});
          await dispatchNotification({
            type: 'SERVER_STOPPED',
            title: `⏹️ "${server.name}" has stopped`,
            body: 'The server finished shutting down cleanly.',
            fields: [{ name: 'Node', value: node.name }],
          });
          continue;
        }

        // Came up (either finished booting, or was started outside the panel)
        if (live.running && (server.status === 'OFFLINE' || server.status === 'ERROR')) {
          summary.events.push(`${server.name}: STARTED`);
          await prisma.server.update({ where: { id: server.id }, data: { status: 'RUNNING' } }).catch(() => {});
          await dispatchNotification({
            type: 'SERVER_STARTED',
            title: `🟢 "${server.name}" is online`,
            body: 'The server is accepting connections.',
            fields: [{ name: 'Node', value: node.name }],
          });
          continue;
        }

        // Silent drift with no alert-worthy transition (e.g. STARTING -> RUNNING)
        if (live.running && server.status === 'STARTING') {
          await prisma.server.update({ where: { id: server.id }, data: { status: 'RUNNING' } }).catch(() => {});
          continue;
        }

        // ── Sleep on empty ──
        if (!live.running) continue;

        const verdict = evaluateSleep({
          sleepEnabled: server.sleepEnabled,
          sleepAfterMinutes: server.sleepAfterMinutes,
          sleepEmptySince: server.sleepEmptySince,
          players: live.players ?? null,
        });

        if (verdict.action === 'mark-empty') {
          await prisma.server.update({
            where: { id: server.id },
            data: { sleepEmptySince: new Date() },
          }).catch(() => {});
        } else if (verdict.action === 'clear-empty') {
          await prisma.server.update({
            where: { id: server.id },
            data: { sleepEmptySince: null },
          }).catch(() => {});
        } else if (verdict.action === 'sleep') {
          const minutes = Math.round(verdict.emptyForMs / 60_000);
          try {
            await requestSleep(node, server);
            summary.events.push(`${server.name}: SLEEPING (empty ${minutes}m)`);
            await prisma.server.update({
              where: { id: server.id },
              data: { status: 'SLEEPING', sleepEmptySince: null, lastSleptAt: new Date() },
            }).catch(() => {});
            await dispatchNotification({
              type: 'SERVER_SLEPT',
              title: `🌙 "${server.name}" went to sleep`,
              body:
                `No players for ${minutes} minutes, so the server was stopped to free up resources. ` +
                'It still shows up in the server list and starts again the moment somebody tries to join.',
              fields: [
                { name: 'Node', value: node.name },
                { name: 'Memory freed', value: `${server.memoryMb} MB` },
              ],
            });
          } catch (err: any) {
            summary.events.push(`${server.name}: sleep failed (${err.message})`);
          }
        }
      }
    }

    // ── Scheduled tasks ──
    // Runs last so a schedule acting on a server sees state this tick already reconciled.
    // Failures are captured per schedule, so one broken schedule can't stop the others.
    const scheduleResults = await runDueSchedules();
    summary.schedulesRun = scheduleResults.map(
      (r) => `${r.name} (${r.action}): ${r.ok ? 'ok' : `FAILED — ${r.message}`}`
    );

    return NextResponse.json({ ok: true, ...summary });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
