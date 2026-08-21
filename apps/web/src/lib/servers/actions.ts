import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { registerServerWithProxy } from '@/lib/servers/proxy-sync';
import { serverStartBlock } from '@/lib/servers/suspension';
import { ServerType } from '@mc-manager/shared';

export type LifecycleAction = 'start' | 'stop' | 'restart';

export interface ActionableServer {
  id: string;
  containerId: string | null;
  // Carried for the same reason the panel's own route carries them: the start below
  // falls back to creating the server, and a create without these makes a Minecraft
  // server out of a Terraria one.
  game?: string | null;
  gameConfig?: unknown;
  serverType: string;
  mcVersion: string;
  modpackSlug: string | null;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  eulaAccepted: boolean;
  executionMode: string;
  node: { host: string; port: number; apiKey: string };
}

/**
 * Start/stop/restart path for the Discord bot, mirroring the panel's own
 * `/api/servers/[id]/action` route (Velocity registration, DB status updates).
 * Kept separate from that route rather than shared, so a bot-specific change can't
 * accidentally alter the panel's own action handling.
 *
 * Being a separate copy is also how it drifted: it was missing the suspension check, the
 * game carry-through and the container-id prefix the panel route has. Anything added to
 * that route which decides *whether* a server may start belongs here too — a control the
 * bot does not enforce is a control anyone in the Discord can walk around.
 */
export async function runServerAction(server: ActionableServer, action: LifecycleAction): Promise<{ message: string; status: string }> {
  const daemonClient = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
  /*
   * `process-` prefixed, as the panel does. A bare id names a container that does not
   * exist, so the start throws, and the catch below "recovers" by creating a second
   * server under that name — leaving the real one untouched and the player watching a
   * fresh world boot.
   */
  const targetContainerId = server.containerId || `process-${server.id}`;

  // A suspended server, or one whose owner is suspended, may still be stopped. Only
  // bringing it back up is blocked.
  if (action === 'start' || action === 'restart') {
    const block = await serverStartBlock(server.id);
    if (block) throw new Error(block);
  }

  if (action === 'start' || action === 'restart') {
    const serverMeta = {
      serverId: server.id,
      game: server.game || undefined,
      gameConfig: server.gameConfig || undefined,
      serverType: server.serverType as ServerType,
      mcVersion: server.mcVersion,
      modpackSlug: server.modpackSlug || undefined,
      serverPort: server.serverPort,
      memoryMb: server.memoryMb,
      cpuLimit: server.cpuLimit,
      eulaAccepted: true,
      executionMode: server.executionMode,
    };

    try {
      if (action === 'restart') {
        await daemonClient.restartServer(targetContainerId);
      } else {
        await daemonClient.startServer(targetContainerId, serverMeta);
      }
    } catch (e: any) {
      await daemonClient.createServer(serverMeta as any);
      await daemonClient.startServer(targetContainerId, serverMeta);
    }

    await registerServerWithProxy(server.id);
    await prisma.server.update({ where: { id: server.id }, data: { containerId: targetContainerId, status: 'RUNNING' } });
    return { message: 'Server start/restart command sent', status: 'RUNNING' };
  }

  // stop
  try {
    await daemonClient.stopServer(targetContainerId);
  } catch (e: any) {
    console.warn(`[server-actions] Stop warning: ${e.message}`);
  }
  // Deliberately still registered with the proxy. A stopped server is the one people are
  // trying to reach when they want it woken, and unregistering it removes that route.
  await prisma.server.update({ where: { id: server.id }, data: { containerId: targetContainerId, status: 'STOPPING' } });
  return { message: 'Server stop command sent', status: 'STOPPING' };
}
