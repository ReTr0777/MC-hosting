import os from 'os';
import { getConfig } from '../config';

/**
 * How much of this machine may be given to servers.
 *
 * A node is often somebody's own PC rather than a rack unit, and its owner wants to keep
 * some of it. Everywhere that used to ask the hardware how big it is asks this instead,
 * so one setting decides both what the panel is told the node holds and what the node
 * will actually agree to run.
 *
 * CPU is counted in *logical processors* — threads — throughout. That is the unit Docker
 * takes (`--cpus`, and NanoCpus underneath it) and the unit a server's own cpuLimit is
 * already in, so budgeting in anything else would mean converting at every boundary and
 * getting it wrong somewhere. It is deliberately not the physical core count that the
 * health report calls `cpuCores`: on an SMT chip those differ by a factor of two, which
 * is the whole reason this comment exists.
 */
export interface Allowance {
  memoryMb: number;
  /** Logical processors, matching `docker run --cpus`. Not physical cores. */
  cpus: number;
  /** False when nothing was held back, i.e. these are just the machine's own figures. */
  capped: boolean;
}

/** Smallest cap worth accepting: below this nothing can be placed at all. */
const MIN_MEMORY_MB = 1024;
const MIN_CPUS = 0.5;

export function machineMemoryMb(): number {
  return Math.round(os.totalmem() / (1024 * 1024));
}

/**
 * Logical processors on this machine.
 *
 * os.cpus() enumerates threads, not cores — 16 entries on an 8-core chip with SMT. That
 * is the number wanted here, because it is what Docker will let a container use.
 */
export function machineCpus(): number {
  return os.cpus().length || 1;
}

/**
 * Resolves the configured cap against the hardware.
 *
 * Clamped rather than trusted: a cap larger than the machine would have the panel place
 * servers this node cannot hold, and one of zero would leave it advertising a capacity it
 * can never satisfy. Both are reachable by hand-editing config.json.
 */
export function resolveAllowance(): Allowance {
  const config = getConfig();
  const physicalMemory = machineMemoryMb();
  const physicalCpus = machineCpus();

  const rawMemory = Number(config.maxMemoryMb) || 0;
  const rawCpus = Number(config.maxCpus) || 0;

  const memoryMb =
    rawMemory > 0 ? Math.min(physicalMemory, Math.max(MIN_MEMORY_MB, Math.round(rawMemory))) : physicalMemory;
  const cpus = rawCpus > 0 ? Math.min(physicalCpus, Math.max(MIN_CPUS, rawCpus)) : physicalCpus;

  return {
    memoryMb,
    cpus: Math.round(cpus * 100) / 100,
    capped: memoryMb < physicalMemory || cpus < physicalCpus,
  };
}

/**
 * Whether a single server fits inside the allowance at all.
 *
 * Only catches the case that no amount of scheduling can fix — one server asking for more
 * than the whole allowance. Deciding whether it fits *alongside* the others is the panel's
 * job: it knows what else is placed here, and it refuses before the server is ever created
 * (see apps/web/src/lib/servers/node-capacity.ts). This is the backstop for a request that
 * reached the node anyway, because the panel's copy of the capacity was stale.
 */
export function allowanceRefusal(memoryMb: number, cpuLimit: number): string | null {
  const allowance = resolveAllowance();
  if (!allowance.capped) return null;

  if (memoryMb > allowance.memoryMb) {
    return (
      `This machine is set to offer at most ${allowance.memoryMb} MB of RAM to servers, and this one asks for ` +
      `${memoryMb} MB. Raise the limit in the node app (Resources), or give the server less.`
    );
  }
  if (cpuLimit > allowance.cpus) {
    return (
      `This machine is set to offer at most ${allowance.cpus} CPUs to servers, and this one asks for ` +
      `${cpuLimit}. Raise the limit in the node app (Resources), or give the server fewer.`
    );
  }
  return null;
}
