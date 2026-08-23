import type { DaemonHealthDto } from '@mc-manager/shared';

/**
 * What a health report says this node's capacity is, as a Prisma update patch.
 *
 * The health poll used to write `totalMemory: health.memoryUsage.total` — the RAM the
 * hardware has — on every tick. That is right for a machine dedicated to hosting and
 * wrong for one that is not: a node whose owner offered 8 GB of their 32 GB desktop had
 * the cap overwritten seconds later, and the scheduler went back to placing servers
 * against the full 32.
 *
 * So a capped node's own figures win, and an uncapped one behaves exactly as before.
 * totalCpu is only ever written for a capped node, because for everyone else it is a
 * number an operator set by hand and nothing has been reporting it since.
 */
export function reportedCapacityPatch(
  health: Pick<DaemonHealthDto, 'memoryUsage' | 'allowance'> | null | undefined
): { totalMemory?: number; totalCpu?: number } {
  const allowance = health?.allowance;

  if (allowance?.capped && allowance.memoryMb > 0) {
    return {
      totalMemory: Math.round(allowance.memoryMb),
      /*
       * totalCpu counts logical processors, the same unit as a server's cpuLimit and as
       * the figure a node sends when it enrols — not the physical core count the health
       * report calls cpuCores. Docker takes fractional CPUs but the budget counts whole
       * ones, and rounding up would hand back a thread the owner held in reserve.
       */
      ...(allowance.cpus > 0 ? { totalCpu: Math.max(1, Math.floor(allowance.cpus)) } : {}),
    };
  }

  return health?.memoryUsage?.total ? { totalMemory: health.memoryUsage.total } : {};
}
