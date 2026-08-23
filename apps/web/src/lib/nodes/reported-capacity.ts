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
      // Docker takes fractional NanoCpus, but the capacity budget counts whole cores;
      // rounding up would hand out a core the owner held back.
      ...(allowance.cpuCores > 0 ? { totalCpu: Math.max(1, Math.floor(allowance.cpuCores)) } : {}),
    };
  }

  return health?.memoryUsage?.total ? { totalMemory: health.memoryUsage.total } : {};
}
