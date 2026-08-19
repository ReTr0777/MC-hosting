import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { isHealthOnline } from '@/lib/services/node-status';
import { dispatchNotification } from '@/lib/services/notifications';
import { monitorKey } from '@/lib/auth/monitor-auth';
import { runDueSchedules } from '@/lib/servers/scheduler';
import { evaluateSleep, requestSleep } from '@/lib/servers/sleep';
import { evaluateCrashRestart, attemptAutoRestart } from '@/lib/servers/crash-restart';
import { serverStartBlock } from '@/lib/servers/suspension';
import { pruneBackupsForServer } from '@/lib/servers/backup-retention';
import { syncProxyServers } from '@/lib/servers/proxy-sync';

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
      /** The server answered a status ping — i.e. it is genuinely joinable, not merely booting. */
      pingOk?: boolean;
      mode: string;
      sleeping?: boolean;
      players?: number | null;
      maxPlayers?: number | null;
      playerNames?: string[] | null;
      cpuPercent?: number | null;
      memoryMb?: number | null;
    }
  >;
}

/**
 * Best-effort last-seen player names per server, for join/leave notifications.
 * In-memory only (resets on deploy) — names come from the status ping's "sample" field,
 * which some servers omit or truncate, so this is a nice-to-have, not authoritative.
 */
const lastSeenPlayers = new Map<string, Set<string>>();

/** One completed visit, as reported by the daemon's presence tracker. */
interface DaemonPlayerSession {
  serverId: string;
  username: string;
  uuid: string | null;
  joinedAt: string;
  leftAt: string;
  seconds: number;
}

/**
 * Writes one session and folds it into the player's running totals.
 *
 * `upsert` on (serverId, username) is what makes this safe to call repeatedly: the first sighting
 * of a name creates the player row, every later one just accumulates. The totals are denormalised
 * because the alternative — summing the session table on every page load — gets slow on a server
 * that has been up for a year.
 */
async function recordPlaySession(session: DaemonPlayerSession): Promise<void> {
  const joinedAt = new Date(session.joinedAt);
  const leftAt = new Date(session.leftAt);
  // A session shorter than a second is a connection that failed during login, not a visit.
  if (session.seconds < 1) return;

  const player = await prisma.serverPlayer.upsert({
    where: { serverId_username: { serverId: session.serverId, username: session.username } },
    create: {
      serverId: session.serverId,
      username: session.username,
      uuid: session.uuid,
      firstSeenAt: joinedAt,
      lastSeenAt: leftAt,
      playtimeSeconds: session.seconds,
      sessionCount: 1,
    },
    update: {
      lastSeenAt: leftAt,
      playtimeSeconds: { increment: session.seconds },
      sessionCount: { increment: 1 },
      // Backfills the UUID for players first seen before the server logged one.
      ...(session.uuid ? { uuid: session.uuid } : {}),
    },
  });

  await prisma.playerSession.create({
    data: {
      playerId: player.id,
      serverId: session.serverId,
      joinedAt,
      leftAt,
      seconds: session.seconds,
    },
  });
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
    proxyServers: 0,
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
        nodeOnline = isHealthOnline(health);
      } catch (err) {
        nodeOnline = false;
      }

      // A node that just came back after being unreachable may have restarted (host reboot,
      // Docker Engine restart, or the daemon container itself being updated). PROCESS-mode
      // servers run as children of the daemon and die with it, so anything the DB still
      // thinks is RUNNING/STARTING needs to be resumed here — unconditionally, since this
      // isn't a crash the server caused, it's the node bouncing.
      const nodeJustCameBack = nodeOnline && !node.isOnline;

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
              liveJavaMajor: health?.javaMajor ?? null,
              liveDataDiskFreeMb: health?.dataDiskFreeMb ?? null,
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

      // ── Play sessions ──
      // Draining empties the daemon's queue, so this must persist what it takes. Failures are
      // logged rather than swallowed: a silent loss here shows up much later as missing playtime.
      try {
        const serverIds = new Set(node.servers.map((s) => s.id));
        const { sessions } = await client.request<{ sessions: DaemonPlayerSession[] }>(
          '/servers/players/sessions/drain',
          { method: 'POST' },
          15000
        );
        for (const session of sessions) {
          if (!serverIds.has(session.serverId)) continue;
          await recordPlaySession(session);
        }
        if (sessions.length > 0) summary.events.push(`Recorded ${sessions.length} play session(s)`);
      } catch (err: any) {
        console.warn(`[monitor] Session drain failed for node ${node.name}:`, err?.message);
      }

      for (const server of node.servers) {
        summary.serversChecked++;
        const live = bulk.statuses?.[server.id];
        if (!live) continue;

        // ── Player join/leave (best-effort, only when the status ping publishes names) ──
        if (live.running && !live.sleeping && live.playerNames) {
          const nowSeen = new Set(live.playerNames);
          const previouslySeen = lastSeenPlayers.get(server.id);

          if (previouslySeen) {
            for (const name of Array.from(nowSeen)) {
              if (!previouslySeen.has(name)) {
                await dispatchNotification({
                  type: 'PLAYER_JOINED',
                  title: `👋 ${name} joined "${server.name}"`,
                  body: `${name} connected to the server.`,
                  fields: [{ name: 'Node', value: node.name }],
                });
              }
            }
            for (const name of Array.from(previouslySeen)) {
              if (!nowSeen.has(name)) {
                await dispatchNotification({
                  type: 'PLAYER_LEFT',
                  title: `👋 ${name} left "${server.name}"`,
                  body: `${name} disconnected from the server.`,
                  fields: [{ name: 'Node', value: node.name }],
                });
              }
            }
          }

          lastSeenPlayers.set(server.id, nowSeen);
        } else if (!live.running || live.sleeping) {
          lastSeenPlayers.delete(server.id);
        }

        // ── Resource history sample ──
        // Null when the server isn't running or the daemon couldn't sample it.
        if (live.running && !live.sleeping && live.cpuPercent !== null && live.cpuPercent !== undefined) {
          await prisma.serverStatSample.create({
            data: {
              serverId: server.id,
              cpuPercent: live.cpuPercent,
              memoryMb: live.memoryMb ?? 0,
              playerCount: live.players ?? null,
            },
          }).catch(() => {});
        }

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

        // STARTING counts as "we believed it was up": the container was created and handed off,
        // so if it has since vanished the boot crashed and deserves the same handling as a
        // crash mid-session. (Before start set STARTING instead of RUNNING, this case arrived
        // here labelled RUNNING and was covered by the same branch.)
        const dbSaysUp = server.status === 'RUNNING' || server.status === 'STARTING';
        const recentlyTouched = Date.now() - new Date(server.updatedAt).getTime() < STARTUP_GRACE_MS;

        // Node just bounced back: resume anything that was supposed to be up, regardless of
        // the per-server autoRestartEnabled toggle (that setting is about tolerating real
        // in-place crashes, not about coming back after the whole node was unreachable).
        if (nodeJustCameBack && (server.status === 'RUNNING' || server.status === 'STARTING') && !live.running) {
          if (await serverStartBlock(server.id)) {
            summary.events.push(`${server.name}: suspended, not resumed`);
            await prisma.server.update({ where: { id: server.id }, data: { status: 'OFFLINE' } }).catch(() => {});
            continue;
          }
          try {
            await attemptAutoRestart(node, server);
            summary.events.push(`${server.name}: RESUMED (node came back online)`);
            await prisma.server.update({ where: { id: server.id }, data: { status: 'STARTING' } }).catch(() => {});
            await dispatchNotification({
              type: 'SERVER_STARTED',
              title: `🟢 "${server.name}" resumed`,
              body: 'The node it runs on had gone unreachable and just came back, so the panel restarted it automatically.',
              fields: [{ name: 'Node', value: node.name }],
            });
          } catch (err: any) {
            summary.events.push(`${server.name}: resume failed (${err.message})`);
          }
          continue;
        }

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

          const now = new Date();
          // A suspended server is not brought back by auto-restart — the crash is still
          // recorded and announced, it just isn't acted on.
          const restartBlocked = !!(await serverStartBlock(server.id));
          const verdict = evaluateCrashRestart({
            autoRestartEnabled: server.autoRestartEnabled && !restartBlocked,
            crashCount: server.crashCount,
            crashWindowStartedAt: server.crashWindowStartedAt,
            lastCrashAt: server.lastCrashAt,
            now,
          });

          if (verdict.action === 'restart') {
            await prisma.server.update({
              where: { id: server.id },
              data: { crashCount: verdict.crashCount, crashWindowStartedAt: verdict.crashWindowStartedAt, lastCrashAt: now },
            }).catch(() => {});
            try {
              await attemptAutoRestart(node, server);
              summary.events.push(`${server.name}: AUTO-RESTARTED (attempt ${verdict.crashCount}/3)`);
              await prisma.server.update({ where: { id: server.id }, data: { status: 'STARTING' } }).catch(() => {});
            } catch (err: any) {
              summary.events.push(`${server.name}: auto-restart failed (${err.message})`);
            }
          } else if (verdict.action === 'loop') {
            await prisma.server.update({
              where: { id: server.id },
              data: { crashCount: verdict.crashCount, crashWindowStartedAt: verdict.crashWindowStartedAt, lastCrashAt: now },
            }).catch(() => {});
            summary.events.push(`${server.name}: CRASH LOOP (${verdict.crashCount} crashes)`);
            await dispatchNotification({
              type: 'SERVER_CRASH_LOOP',
              title: `🔁 "${server.name}" is stuck in a crash loop`,
              body: `The server has crashed ${verdict.crashCount} times in the last 30 minutes. Auto-restart has been paused — check the console for a crash report before restarting manually.`,
              fields: [{ name: 'Node', value: node.name }],
            });
          } else if (verdict.action === 'backoff') {
            await prisma.server.update({
              where: { id: server.id },
              data: { crashCount: verdict.crashCount, crashWindowStartedAt: verdict.crashWindowStartedAt },
            }).catch(() => {});
          }

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

        // "Up" means joinable, not merely process-alive. Older daemons don't report pingOk, so
        // fall back to `running` there rather than pinning those servers at STARTING forever.
        const joinable = live.pingOk ?? live.running;

        // Came up (either finished booting, or was started outside the panel)
        if (joinable && (server.status === 'OFFLINE' || server.status === 'ERROR')) {
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
        if (joinable && server.status === 'STARTING') {
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

    // ── Resource history retention ──
    // Runs probabilistically (~once per 20 min at the default 45s tick) rather than every
    // tick — a prune DELETE doesn't need to run every 45 seconds.
    if (Math.random() < 0.04) {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      await prisma.serverStatSample.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => {});
    }

    // ── Backup retention sweep ──
    // Pruning also runs right after each backup, but an age rule ("nothing older than 30 days")
    // comes due on its own, without anybody taking a new backup. Same probabilistic cadence:
    // listing every server's backups over the network is not a per-tick operation.
    if (Math.random() < 0.04) {
      const withPolicy = await prisma.server.findMany({
        where: {
          OR: [
            { backupRetentionCount: { not: null } },
            { backupRetentionDays: { not: null } },
            { backupMaxTotalMb: { not: null } },
          ],
        },
        select: { id: true, name: true },
      }).catch(() => []);

      for (const server of withPolicy) {
        const result = await pruneBackupsForServer(server.id).catch(() => null);
        if (result?.deleted.length) {
          summary.events.push(`${server.name}: pruned ${result.deleted.length} backup(s)`);
        }
      }
    }

    // ── Proxy routing ──
    // Re-registers every server with Velocity. The proxy keeps this only in memory, so a
    // proxy that restarted has forgotten every route until something tells it again, and
    // this is that something.
    summary.proxyServers = await syncProxyServers();

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
