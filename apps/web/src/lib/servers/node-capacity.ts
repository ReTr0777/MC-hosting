import { prisma } from '@/lib/prisma';

/**
 * How much of a node is already spoken for.
 *
 * Per-user quotas (lib/quota.ts) answer "is this user allowed to ask for this?". This answers
 * the other half — "does the machine actually have it?". Without it a node with 32 GB of RAM
 * will happily accept 60 GB of servers, and the first time they all start at once the host
 * OOM-kills them in an order nobody chose.
 *
 * Two different numbers matter and they are not interchangeable:
 *   - allocated: every server on the node, running or not. This is what capacity planning uses,
 *     because an offline server is one player away from being an online one.
 *   - active: only servers currently up. This is what the here-and-now pressure looks like.
 *
 * `overcommitRatio` exists because a Minecraft server almost never holds its full -Xmx heap,
 * so packing 1.5x allocated onto a node is a deliberate, and common, operator choice.
 *
 * RAM and CPU are budgeted separately, and deliberately not with the same strictness. A heap is
 * close to reserved once the JVM grows into it, but `cpuLimit` is only a ceiling — Docker's
 * NanoCpus caps a burst, it does not hold a core, an idle server uses nearly none, and a
 * PROCESS-mode server is never capped at all. Summing ceilings against physical cores at 1x is
 * how a four-core node with three sleeping servers reports itself full, so CPU carries its own
 * `cpuOvercommitRatio`, defaulting to 4x.
 */

/** Used when a node row has no CPU ratio of its own — see the note on ceilings above. */
export const DEFAULT_CPU_OVERCOMMIT = 4;

/** Statuses that mean the server is holding its allocation on the host right now. */
const ACTIVE_STATUSES = ['RUNNING', 'STARTING', 'RESTARTING'];

export interface CapacityServer {
  id: string;
  memoryMb: number;
  cpuLimit: number;
  status: string;
}

export interface CapacityNode {
  id: string;
  name: string;
  totalMemory: number;
  totalCpu: number;
  overcommitRatio: number;
  /** Older node rows predate this column; they fall back to the 4x default. */
  cpuOvercommitRatio?: number | null;
}

export interface NodeCapacity {
  nodeId: string;
  nodeName: string;
  overcommitRatio: number;
  cpuOvercommitRatio: number;
  serverCount: number;
  /** Sum over every server on the node, regardless of state. */
  allocatedMemoryMb: number;
  allocatedCpu: number;
  /** Sum over servers that are currently up. */
  activeMemoryMb: number;
  activeCpu: number;
  /**
   * The allocation budget after overcommit. Null means the node was registered without a
   * meaningful total, so there is nothing to measure against and everything is permitted.
   */
  memoryBudgetMb: number | null;
  cpuBudget: number | null;
  freeMemoryMb: number | null;
  freeCpu: number | null;
}

function budget(total: number, ratio: number): number | null {
  // A node registered with 0 (or a negative) total is unconfigured, not full.
  if (!Number.isFinite(total) || total <= 0) return null;
  return total * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
}

/** Pure form, so the arithmetic can be tested without a database. */
export function computeCapacity(node: CapacityNode, servers: CapacityServer[]): NodeCapacity {
  const active = servers.filter((s) => ACTIVE_STATUSES.includes(s.status));

  const allocatedMemoryMb = servers.reduce((sum, s) => sum + s.memoryMb, 0);
  const allocatedCpu = servers.reduce((sum, s) => sum + s.cpuLimit, 0);

  const cpuRatio =
    Number.isFinite(node.cpuOvercommitRatio) && (node.cpuOvercommitRatio as number) > 0
      ? (node.cpuOvercommitRatio as number)
      : DEFAULT_CPU_OVERCOMMIT;

  const memoryBudgetMb = budget(node.totalMemory, node.overcommitRatio);
  const cpuBudget = budget(node.totalCpu, cpuRatio);

  return {
    nodeId: node.id,
    nodeName: node.name,
    overcommitRatio: node.overcommitRatio,
    cpuOvercommitRatio: cpuRatio,
    serverCount: servers.length,
    allocatedMemoryMb,
    allocatedCpu: Math.round(allocatedCpu * 100) / 100,
    activeMemoryMb: active.reduce((sum, s) => sum + s.memoryMb, 0),
    activeCpu: Math.round(active.reduce((sum, s) => sum + s.cpuLimit, 0) * 100) / 100,
    memoryBudgetMb,
    cpuBudget,
    freeMemoryMb: memoryBudgetMb == null ? null : Math.max(0, memoryBudgetMb - allocatedMemoryMb),
    freeCpu: cpuBudget == null ? null : Math.round(Math.max(0, cpuBudget - allocatedCpu) * 100) / 100,
  };
}

/** Whether one server of this size still fits on the node. A message to show, or null. */
export function capacityViolation(
  capacity: NodeCapacity,
  request: { memoryMb: number; cpuLimit: number }
): string | null {
  if (capacity.freeMemoryMb != null && request.memoryMb > capacity.freeMemoryMb) {
    return (
      `Node "${capacity.nodeName}" does not have room: ${request.memoryMb} MB requested but only ` +
      `${capacity.freeMemoryMb} MB of its ${capacity.memoryBudgetMb} MB allocation budget is free ` +
      `(${capacity.allocatedMemoryMb} MB already allocated to ${capacity.serverCount} server(s)).`
    );
  }

  if (capacity.freeCpu != null && request.cpuLimit > capacity.freeCpu) {
    return (
      `Node "${capacity.nodeName}" does not have room: ${request.cpuLimit} core(s) requested but only ` +
      `${capacity.freeCpu} of its ${capacity.cpuBudget} core allocation budget is free ` +
      `(${capacity.allocatedCpu} already allocated across ${capacity.serverCount} server(s), including ` +
      `stopped ones). These are per-server ceilings rather than live usage — raise the node's total ` +
      `cores or its CPU overcommit ratio if the machine is not actually busy.`
    );
  }

  return null;
}

/**
 * Headroom demanded on top of a server's own size before it may be moved onto a node.
 *
 * Extraction needs the full uncompressed size and provisioning writes on top of it, so
 * landing at exactly zero free is a failure even when the arithmetic says it fits. A
 * tenth over plus a floor for small servers is headroom, not a prediction of what
 * provisioning will use.
 */
const DISK_HEADROOM_DIVISOR = 10;
const DISK_HEADROOM_FLOOR_MB = 512;

export function diskSpaceNeededMb(sizeMb: number): number {
  // Divided rather than multiplied by 1.1: that product is 11000.000000000002 for a
  // 10 GB server, and ceil turns the rounding error into a megabyte that appears in
  // the refusal message for no reason anyone could explain.
  return sizeMb + Math.ceil(sizeMb / DISK_HEADROOM_DIVISOR) + DISK_HEADROOM_FLOOR_MB;
}

/**
 * Whether a node has the disk to receive a server of this size. A message, or null.
 *
 * Separate from capacityViolation because it answers a different question with a
 * different number: that one budgets RAM and cores against an overcommit ratio, this
 * one is physical space that either exists or does not. A node can pass either and
 * fail the other.
 *
 * Null for `sizeMb` or `freeMb` means one end could not say, and passes — the same
 * rule the Java and transfer checks follow.
 */
export function diskSpaceViolation(
  nodeName: string,
  sizeMb: number | null | undefined,
  freeMb: number | null | undefined
): string | null {
  if (sizeMb == null || freeMb == null) return null;

  const needed = diskSpaceNeededMb(sizeMb);
  if (freeMb >= needed) return null;

  return (
    `Node "${nodeName}" does not have room on disk: the server is ${sizeMb} MB and needs about ` +
    `${needed} MB with headroom, but only ${freeMb} MB is free where that node stores its servers.`
  );
}

/**
 * @param excludeServerId Server whose allocation should not count — set when resizing or
 *   migrating, so a server is never measured against space it is itself occupying.
 */
export async function nodeCapacity(
  nodeId: string,
  opts: { excludeServerId?: string } = {}
): Promise<NodeCapacity | null> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, name: true, totalMemory: true, totalCpu: true, overcommitRatio: true, cpuOvercommitRatio: true },
  });
  if (!node) return null;

  const servers = await prisma.server.findMany({
    where: {
      nodeId,
      ...(opts.excludeServerId ? { id: { not: opts.excludeServerId } } : {}),
    },
    select: { id: true, memoryMb: true, cpuLimit: true, status: true },
  });

  return computeCapacity(node, servers);
}

/** Capacity for every node in one pass, keyed by node id. Used by the nodes list and scheduler. */
export async function allNodeCapacities(): Promise<Map<string, NodeCapacity>> {
  const nodes = await prisma.node.findMany({
    select: {
      id: true,
      name: true,
      totalMemory: true,
      totalCpu: true,
      overcommitRatio: true,
      cpuOvercommitRatio: true,
      servers: { select: { id: true, memoryMb: true, cpuLimit: true, status: true } },
    },
  });

  return new Map(nodes.map((node) => [node.id, computeCapacity(node, node.servers)]));
}
