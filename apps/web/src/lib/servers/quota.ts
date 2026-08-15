import { prisma } from '@/lib/prisma';

/**
 * A user's quota position at a point in time: the limits they were given, what their own
 * servers already consume, and the resulting ceiling for one server.
 *
 * Quotas count only servers the user OWNS — shared access to someone else's server is free.
 * GLOBAL_ADMIN is exempt entirely.
 */
export interface QuotaSnapshot {
  unlimited: boolean;
  maxServers: number | null;
  maxMemoryMb: number | null;
  maxCpu: number | null;
  maxServerMemoryMb: number | null;
  maxServerCpu: number | null;
  usedServers: number;
  usedMemoryMb: number;
  usedCpu: number;
  /** Largest one server may be, from the per-server cap and the unused part of the total. */
  memoryCeiling: number | null;
  cpuCeiling: number | null;
}

function tightest(perServer: number | null, total: number | null, used: number): number | null {
  const caps: number[] = [];
  if (perServer != null) caps.push(perServer);
  if (total != null) caps.push(Math.max(0, total - used));
  return caps.length ? Math.min(...caps) : null;
}

/**
 * @param excludeServerId Server whose current allocation should not count as "used" — set when
 *   resizing, so a server is never measured against a budget it is itself occupying.
 */
export async function quotaSnapshot(
  userId: string,
  opts: { excludeServerId?: string } = {}
): Promise<QuotaSnapshot> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      globalRole: true,
      maxServers: true,
      maxMemoryMb: true,
      maxCpu: true,
      maxServerMemoryMb: true,
      maxServerCpu: true,
    },
  });

  const owned = await prisma.server.findMany({
    where: {
      permissions: { some: { userId, role: 'OWNER' } },
      ...(opts.excludeServerId ? { id: { not: opts.excludeServerId } } : {}),
    },
    select: { memoryMb: true, cpuLimit: true },
  });

  const usedServers = owned.length;
  const usedMemoryMb = owned.reduce((sum, s) => sum + s.memoryMb, 0);
  const usedCpu = owned.reduce((sum, s) => sum + s.cpuLimit, 0);

  const exempt =
    !user ||
    user.globalRole === 'GLOBAL_ADMIN' ||
    (user.maxServers == null && user.maxMemoryMb == null && user.maxCpu == null &&
      user.maxServerMemoryMb == null && user.maxServerCpu == null);

  if (exempt) {
    return {
      unlimited: true,
      maxServers: null, maxMemoryMb: null, maxCpu: null,
      maxServerMemoryMb: null, maxServerCpu: null,
      usedServers, usedMemoryMb, usedCpu,
      memoryCeiling: null, cpuCeiling: null,
    };
  }

  return {
    unlimited: false,
    maxServers: user.maxServers,
    maxMemoryMb: user.maxMemoryMb,
    maxCpu: user.maxCpu,
    maxServerMemoryMb: user.maxServerMemoryMb,
    maxServerCpu: user.maxServerCpu,
    usedServers, usedMemoryMb, usedCpu,
    memoryCeiling: tightest(user.maxServerMemoryMb, user.maxMemoryMb, usedMemoryMb),
    cpuCeiling: tightest(user.maxServerCpu, user.maxCpu, usedCpu),
  };
}

/**
 * Whether one server of this size fits. Returns a message to show the user, or null if it fits.
 * `countsAsNew` adds the server to the count check — false when resizing an existing one.
 */
export function quotaViolation(
  snapshot: QuotaSnapshot,
  request: { memoryMb: number; cpuLimit: number; countsAsNew: boolean }
): string | null {
  if (snapshot.unlimited) return null;

  if (request.countsAsNew && snapshot.maxServers != null && snapshot.usedServers + 1 > snapshot.maxServers) {
    return `Server quota exceeded: you can own at most ${snapshot.maxServers} server(s).`;
  }

  // Per-server ceilings are reported first: "this server is too big" is more actionable than
  // "you are out of total budget" when both happen to be true.
  if (snapshot.maxServerMemoryMb != null && request.memoryMb > snapshot.maxServerMemoryMb) {
    return `Memory quota exceeded: a single server may use at most ${snapshot.maxServerMemoryMb} MB (requested: ${request.memoryMb} MB).`;
  }
  if (snapshot.maxServerCpu != null && request.cpuLimit > snapshot.maxServerCpu) {
    return `CPU quota exceeded: a single server may use at most ${snapshot.maxServerCpu} core(s) (requested: ${request.cpuLimit}).`;
  }
  if (snapshot.maxMemoryMb != null && snapshot.usedMemoryMb + request.memoryMb > snapshot.maxMemoryMb) {
    return `Memory quota exceeded: your servers may use at most ${snapshot.maxMemoryMb} MB total (requested total: ${snapshot.usedMemoryMb + request.memoryMb} MB).`;
  }
  if (snapshot.maxCpu != null && snapshot.usedCpu + request.cpuLimit > snapshot.maxCpu) {
    return `CPU quota exceeded: your servers may use at most ${snapshot.maxCpu} core(s) total (requested total: ${snapshot.usedCpu + request.cpuLimit}).`;
  }

  return null;
}

/** The user who owns a server, for quota purposes. Null if nobody holds the OWNER role. */
export async function serverOwnerId(serverId: string): Promise<string | null> {
  const owner = await prisma.serverPermission.findFirst({
    where: { serverId, role: 'OWNER' },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}
