import { prisma } from '@/lib/prisma';

/**
 * Which machine has had a server, and when.
 *
 * Once worlds live on customers' own PCs rather than on the fleet, "whose machine was
 * this on" stops being answerable from the server row: `nodeId` holds the current host
 * and nothing else, and the node it used to name may not exist any more. The audit log
 * records migrations, but by id, in a stream that is not the server's own and that
 * nothing on its page reads.
 *
 * So each stay is a row, opened when a machine takes the server and closed when the next
 * one does. The open row is expected to agree with `Server.nodeId`; it is the closed ones
 * that carry the history.
 */

/** What a stay records about the machine, resolved once and then frozen into the row. */
async function describeNode(node: { id: string; name: string; ownerId: string | null }) {
  const owner = node.ownerId
    ? await prisma.user
        .findUnique({ where: { id: node.ownerId }, select: { username: true } })
        .catch(() => null)
    : null;

  return { nodeId: node.id, nodeName: node.name, ownerName: owner?.username ?? null };
}

/**
 * Hands a server to a machine, ending whatever stay was open.
 *
 * Every failure here is swallowed. This is bookkeeping wrapped around operations that
 * have already happened — a migration that streamed a world across, verified it and
 * deleted the source is not going to be reported as failed because a history row would
 * not write. A gap in the history is recoverable; a migration the panel disowns is not.
 */
export async function recordHostingHandover(
  serverId: string,
  node: { id: string; name: string; ownerId: string | null },
  movedByUserId?: string
): Promise<void> {
  try {
    const now = new Date();
    const described = await describeNode(node);

    /*
     * Closing by serverId rather than by id: more than one open row means something
     * already went wrong, and leaving the extras open would compound it. updateMany
     * closes all of them at the same instant, which is the state the reader expects.
     */
    await prisma.serverHostingEvent.updateMany({
      where: { serverId, endedAt: null },
      data: { endedAt: now },
    });

    await prisma.serverHostingEvent.create({
      data: { serverId, ...described, startedAt: now, movedByUserId: movedByUserId ?? null },
    });
  } catch (err: any) {
    console.warn(`[hosting-history] Could not record the handover of ${serverId}: ${err.message}`);
  }
}

export interface HostingStay {
  nodeName: string;
  ownerName: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * The machines that have had this server, newest first.
 *
 * Empty for a server that predates this record, which is why the caller must say "not
 * recorded" rather than "never moved" — the two look identical from here and only one
 * of them is a fact.
 */
export async function hostingHistory(serverId: string, take = 10): Promise<HostingStay[]> {
  return prisma.serverHostingEvent
    .findMany({
      where: { serverId },
      orderBy: { startedAt: 'desc' },
      take,
      select: { nodeName: true, ownerName: true, startedAt: true, endedAt: true },
    })
    .catch(() => []);
}
