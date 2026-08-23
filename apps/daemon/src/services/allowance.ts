import os from 'os';
import { getConfig } from '../config';

/**
 * How much of this machine may be given to servers.
 *
 * A node is often somebody's own PC rather than a rack unit, and its owner wants to keep
 * some of it. Everywhere that used to ask the hardware how big it is asks this instead,
 * so one setting decides both what the panel is told the node holds and what the node
 * will actually agree to run.
 */
export interface Allowance {
  memoryMb: number;
  cpuCores: number;
  /** False when nothing was held back, i.e. these are just the machine's own figures. */
  capped: boolean;
}

/** Smallest cap worth accepting: below this nothing can be placed at all. */
const MIN_MEMORY_MB = 1024;
const MIN_CPU_CORES = 0.5;

export function machineMemoryMb(): number {
  return Math.round(os.totalmem() / (1024 * 1024));
}

export function machineCpuCores(): number {
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
  const physicalCores = machineCpuCores();

  const rawMemory = Number(config.maxMemoryMb) || 0;
  const rawCores = Number(config.maxCpuCores) || 0;

  const memoryMb =
    rawMemory > 0 ? Math.min(physicalMemory, Math.max(MIN_MEMORY_MB, Math.round(rawMemory))) : physicalMemory;
  const cpuCores = rawCores > 0 ? Math.min(physicalCores, Math.max(MIN_CPU_CORES, rawCores)) : physicalCores;

  return {
    memoryMb,
    cpuCores: Math.round(cpuCores * 100) / 100,
    capped: memoryMb < physicalMemory || cpuCores < physicalCores,
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
  if (cpuLimit > allowance.cpuCores) {
    return (
      `This machine is set to offer at most ${allowance.cpuCores} CPU cores to servers, and this one asks for ` +
      `${cpuLimit}. Raise the limit in the node app (Resources), or give the server fewer.`
    );
  }
  return null;
}
