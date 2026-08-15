import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';

/**
 * Side effects of suspending, kept out of lib/suspension.ts because that module is imported on
 * every authenticated request and has no business pulling in the daemon client.
 *
 * Suspending only blocks *starting*, so anything already running would otherwise keep running
 * until it happened to stop — which makes a suspension look like it did nothing.
 */

const RUNNING_STATUSES = ['RUNNING', 'STARTING', 'RESTARTING', 'SLEEPING'];

/** Stops the given servers, best-effort. Returns the names it managed to stop. */
export async function stopServers(serverIds: string[]): Promise<string[]> {
  if (serverIds.length === 0) return [];

  const servers = await prisma.server.findMany({
    where: { id: { in: serverIds }, status: { in: RUNNING_STATUSES as any } },
    include: { node: true },
  });

  const stopped: string[] = [];
  for (const server of servers) {
    const client = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });
    try {
      await client.stopServer(server.containerId || `process-${server.id}`);
      await prisma.server.update({ where: { id: server.id }, data: { status: 'STOPPING' } });
      stopped.push(server.name);
    } catch (err: any) {
      // An unreachable node is not a reason to refuse the suspension — the DB flag is what
      // actually enforces it, and the monitor tick will reconcile the status later.
      console.warn(`[suspension] Could not stop "${server.name}":`, err?.message);
      await prisma.server.update({ where: { id: server.id }, data: { status: 'OFFLINE' } }).catch(() => {});
    }
  }
  return stopped;
}

/** Every server the user holds the OWNER role on. */
export async function ownedServerIds(userId: string): Promise<string[]> {
  const permissions = await prisma.serverPermission.findMany({
    where: { userId, role: 'OWNER' },
    select: { serverId: true },
  });
  return permissions.map((p) => p.serverId);
}
