import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { isHealthOnline } from '@/lib/services/node-status';
import { nodeCapacity } from '@/lib/servers/node-capacity';
import {
  DaemonHealthDto, GAME_LABELS, isGame, Game,
  daemonVersionState, MIN_SUPPORTED_DAEMON_VERSION,
} from '@mc-manager/shared';

/**
 * Why a node is not behaving, answered without an SSH session.
 *
 * The online badge is one bit, and every distinct failure renders as the same "Offline":
 * a daemon that is not running, one listening on a different port than the panel was
 * told, one whose API key was rotated on only one side, and a tunnel pointing somewhere
 * else all look identical from the outside. Each has a different fix, so this separates
 * them rather than reporting the bit.
 *
 * Read-only. Nothing here changes the node or the stored record — a diagnosis that
 * alters what it is diagnosing is worse than none.
 */

type Level = 'ok' | 'warn' | 'fail' | 'unknown';

interface Check {
  id: string;
  label: string;
  level: Level;
  detail: string;
  /** What to do about it. Omitted when there is nothing to do. */
  remedy?: string;
}

const CONNECT_TIMEOUT_MS = 15000;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  const node = await prisma.node.findUnique({
    where: { id: params.id },
    include: { servers: { select: { id: true, game: true, status: true, memoryMb: true } } },
  });
  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const checks: Check[] = [];
  const url = `${node.port === 443 ? 'https' : 'http'}://${node.host}:${node.port}/api/v1/system/health`;

  /*
   * Deliberately a raw fetch rather than DaemonClient.getHealth.
   *
   * The client collapses every failure into one thrown Error with a human sentence
   * attached, which is right for callers that only need to know it did not work and
   * useless here — the HTTP status is the diagnosis. A 401 and a refused connection
   * arrive as the same exception through that path and are completely different
   * problems with completely different fixes.
   */
  let health: DaemonHealthDto | null = null;
  let latencyMs: number | null = null;

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${node.apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    latencyMs = Date.now() - startedAt;

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      checks.push({
        id: 'auth',
        label: 'API key',
        level: 'fail',
        detail: `The node answered on ${node.host}:${node.port} but rejected the key (HTTP ${res.status}).`,
        remedy:
          'The daemon is running and reachable, so only the key is wrong. Copy the key from the ' +
          'config.json in the node data directory into this node settings form. Editing the ' +
          'container DAEMON_API_KEY variable alone will not change it: config.json overrides it.',
      });
    } else if (!res.ok) {
      checks.push({
        id: 'connect',
        label: 'Reachability',
        level: 'fail',
        detail: `${node.host}:${node.port} answered HTTP ${res.status}.`,
        remedy: 'Something is listening there, but it is not answering as a healthy daemon.',
      });
    } else {
      try {
        health = JSON.parse(text) as DaemonHealthDto;
      } catch {
        checks.push({
          id: 'connect',
          label: 'Reachability',
          level: 'fail',
          detail: `${node.host}:${node.port} answered HTTP 200 with something that is not JSON.`,
          remedy:
            'Another service holds this port, or a tunnel points at one. Check the port matches ' +
            'the port the daemon logs on startup, and that nothing else publishes it.',
        });
      }
    }
  } catch (err: any) {
    latencyMs = Date.now() - startedAt;
    const aborted = err?.name === 'AbortError';
    checks.push({
      id: 'connect',
      label: 'Reachability',
      level: 'fail',
      detail: aborted
        ? `No answer from ${node.host}:${node.port} within ${CONNECT_TIMEOUT_MS / 1000}s.`
        : `Could not connect to ${node.host}:${node.port} — ${err?.message ?? 'unknown error'}.`,
      remedy: aborted
        ? 'The address routes somewhere but nothing replied. Usually a firewall, or a tunnel that ' +
          'is up but not forwarding this port.'
        : 'Connection refused: nothing is listening there. Check the daemon is running and that ' +
          'its published port matches the one configured here. A node behind NAT has to be reached ' +
          'through its tunnel address, not its LAN IP.',
    });
  }

  if (health) {
    checks.push({
      id: 'connect',
      label: 'Reachability',
      level: 'ok',
      detail: `Answered from ${node.host}:${node.port} in ${latencyMs}ms.`,
    });

    const online = isHealthOnline(health);
    checks.push({
      id: 'health',
      label: 'Daemon health',
      level: online ? (health.status === 'degraded' ? 'warn' : 'ok') : 'fail',
      detail: `Reported status "${health.status}", up ${formatUptime(health.uptime)}.`,
      remedy:
        health.status === 'degraded'
          ? 'Degraded normally means the Docker socket is unreachable. Process-mode servers are ' +
            'unaffected; container-mode ones cannot start.'
          : undefined,
    });

    checks.push({
      id: 'docker',
      label: 'Docker',
      level: health.dockerAvailable ? 'ok' : 'warn',
      detail: health.dockerAvailable
        ? 'Docker socket reachable, so container-mode servers can run here.'
        : 'No Docker socket. Only process-mode servers can run on this node.',
      remedy: health.dockerAvailable
        ? undefined
        : 'Harmless if you only run process-mode servers. Otherwise mount /var/run/docker.sock into the daemon.',
    });

    /*
     * Version before anything else that depends on it: half the confusing failures on an
     * old node are a missing endpoint, and "your daemon is from before this existed" is a
     * far more useful thing to read than the error the missing endpoint produces.
     */
    const versionState = daemonVersionState(health.version);
    checks.push({
      id: 'version',
      label: 'Daemon version',
      level: versionState === 'outdated' ? 'warn' : versionState === 'unknown' ? 'warn' : 'ok',
      detail:
        versionState === 'unknown'
          ? 'This daemon does not report a version, which means it predates the field entirely.'
          : `Running ${health.version}. This panel expects ${MIN_SUPPORTED_DAEMON_VERSION} or newer.`,
      remedy:
        versionState === 'current' || versionState === 'ahead'
          ? undefined
          : 'Pull the latest daemon image and recreate this node. Recreating the daemon restarts ' +
            'every server on it, so do it when nobody is playing — maintenance mode keeps new ' +
            'servers from landing here while you work.',
    });

    if (health.javaMajor == null) {
      checks.push({
        id: 'java',
        label: 'Java',
        level: 'unknown',
        detail: 'This daemon does not report its Java version.',
        remedy: 'Update the node so the panel can check Java compatibility before placing servers here.',
      });
    } else {
      checks.push({
        id: 'java',
        label: 'Java',
        level: 'ok',
        detail: `Java ${health.javaMajor} available.`,
      });
    }

    /*
     * Disk is reported twice by the daemon: for the largest mount, and for the filesystem
     * it actually writes worlds to. Only the second can strand a server, so it is the one
     * checked here — a node with a huge empty array and a full data disk looks fine by the
     * other number right up until a world fails to save.
     */
    if (health.dataDiskFreeMb != null) {
      const freeGb = health.dataDiskFreeMb / 1024;
      checks.push({
        id: 'data-disk',
        label: 'Data disk',
        level: freeGb < 2 ? 'fail' : freeGb < 10 ? 'warn' : 'ok',
        detail: `${freeGb.toFixed(1)} GB free where this node stores server data.`,
        remedy:
          freeGb < 10
            ? 'Worlds and backups grow here. Free space before creating more servers on this node.'
            : undefined,
      });
    }
  }

  /*
   * Stored capacity against what the machine says it has.
   *
   * Allocation decisions use the stored figure, so a node registered with a guessed
   * totalMemory quietly refuses servers it could hold, or accepts ones it cannot. Neither
   * shows up anywhere else.
   */
  if (health?.memoryUsage?.total && node.totalMemory) {
    const drift = Math.abs(health.memoryUsage.total - node.totalMemory) / health.memoryUsage.total;
    if (drift > 0.1) {
      checks.push({
        id: 'capacity-drift',
        label: 'Recorded capacity',
        level: 'warn',
        detail:
          `Registered as ${(node.totalMemory / 1024).toFixed(1)} GB but the node reports ` +
          `${(health.memoryUsage.total / 1024).toFixed(1)} GB.`,
        remedy: 'Allocation uses the registered figure. Correct it in this node settings form.',
      });
    }
  }

  const capacity = await nodeCapacity(node.id);
  if (capacity?.memoryBudgetMb != null && capacity.freeMemoryMb != null) {
    const full = capacity.freeMemoryMb <= 0;
    checks.push({
      id: 'allocation',
      label: 'Allocation',
      level: full ? 'warn' : 'ok',
      detail: full
        ? 'Full: every megabyte of the budget is promised to existing servers.'
        : `${(capacity.freeMemoryMb / 1024).toFixed(1)} GB of the budget is unallocated.`,
      remedy: full
        ? 'Raise the overcommit ratio, correct the recorded total, or move a server off this node.'
        : undefined,
    });
  }

  /*
   * Servers whose game the node no longer advertises. They keep running, which is the
   * right behaviour, but nothing else in the panel would ever tell you they are stranded
   * and could not be recreated where they are.
   */
  const stranded = node.servers.filter((s) => isGame(s.game) && !node.enabledGames.includes(s.game));
  if (stranded.length > 0) {
    const games = Array.from(new Set(stranded.map((s) => GAME_LABELS[s.game as Game]))).join(', ');
    checks.push({
      id: 'stranded',
      label: 'Game configuration',
      level: 'warn',
      detail: `${stranded.length} server${stranded.length === 1 ? '' : 's'} here run ${games}, which this node no longer advertises.`,
      remedy: 'They keep running, but none can be recreated here. Re-enable the game, or move them.',
    });
  }

  if (node.drainedAt) {
    checks.push({
      id: 'drain',
      label: 'Maintenance mode',
      level: 'warn',
      detail: `Taking no new servers since ${node.drainedAt.toISOString()}.`,
      remedy: 'Turn maintenance mode off when the work is finished.',
    });
  }

  const summary: Level = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';

  return NextResponse.json({ ranAt: new Date().toISOString(), summary, latencyMs, checks });
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'an unknown time';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
