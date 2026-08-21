import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * Unauthenticated health check, for an external monitor.
 *
 * The point of this endpoint is that it can fail. Pointing a monitor at `/` checks only
 * that Next.js is serving HTML, which it does perfectly happily with the database
 * unreachable — so the panel can be completely unusable while every check stays green.
 * Here the HTTP status answers one question only: can the panel do its job right now.
 *
 * The JSON body carries the detail a status page needs to be more specific than up/down.
 * It deliberately says nothing identifying: no node names, no hostnames, no versions.
 * This URL is reachable by anyone, and a health check is not a place to hand out an
 * inventory of the infrastructure.
 */

export const dynamic = 'force-dynamic';

/** Beyond this, a node's last successful poll is old enough to mean the loop is stuck. */
const MONITOR_STALE_MS = 5 * 60_000;
/** A hung database must fail the check rather than hold the request open until the monitor gives up. */
const DB_TIMEOUT_MS = 5000;

type Health = 'ok' | 'degraded' | 'error';

export async function GET() {
  const startedAt = Date.now();

  let nodes: { total: number; online: number; lastSeenAt: Date | null };
  try {
    nodes = await Promise.race([
      readNodes(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('database timeout')), DB_TIMEOUT_MS)
      ),
    ]);
  } catch {
    /*
     * 503 rather than 500: this is "temporarily unable to serve", which is what it is, and
     * what a monitor should retry rather than page about on a single blip.
     */
    return NextResponse.json(
      { status: 'error' satisfies Health, database: 'unreachable' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  /*
   * `isOnline` is written by the in-process monitor loop, so it is only as trustworthy as
   * that loop. If the newest poll is older than the loop's own interval by a wide margin,
   * the flags are stale and reporting them as fact would be worse than saying so — a panel
   * whose monitor has died shows every node online forever.
   */
  const monitorStale =
    nodes.total > 0 &&
    (!nodes.lastSeenAt || Date.now() - nodes.lastSeenAt.getTime() > MONITOR_STALE_MS);

  // Degraded, not error: the panel itself is fine and every page still works. Only the
  // things that need a node are affected, which is a different component on a status page.
  const status: Health =
    monitorStale || (nodes.total > 0 && nodes.online === 0) ? 'degraded' : 'ok';

  return NextResponse.json(
    {
      status,
      database: 'ok',
      monitorStale,
      nodes: { total: nodes.total, online: nodes.online },
      latencyMs: Date.now() - startedAt,
    },
    // Always 200 here. Both branches mean the panel is serving; a status page can read the
    // body for the finer distinction, and a plain uptime check should not page someone
    // because a single node in a bedroom is switched off.
    { status: 200, headers: { 'cache-control': 'no-store' } }
  );
}

async function readNodes() {
  const [total, online, newest] = await Promise.all([
    prisma.node.count(),
    prisma.node.count({ where: { isOnline: true } }),
    prisma.node.findFirst({
      // Nulls sort first on a Postgres DESC, so a node that has never reported would
      // otherwise come back as "the newest poll" and make every check read as stale.
      where: { liveLastSeenAt: { not: null } },
      orderBy: { liveLastSeenAt: 'desc' },
      select: { liveLastSeenAt: true },
    }),
  ]);
  return { total, online, lastSeenAt: newest?.liveLastSeenAt ?? null };
}
