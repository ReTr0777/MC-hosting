import { prisma } from '@/lib/prisma';
import { DaemonClient } from '@/lib/services/daemon-client';
import { ServerType } from '@mc-manager/shared';

export type LifecycleAction = 'start' | 'stop' | 'restart';

export interface ActionableServer {
  id: string;
  containerId: string | null;
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

async function registerWithVelocity(server: ActionableServer) {
  try {
    const velocityUrl = process.env.VELOCITY_URL || 'http://proxy:3001/api/v1';
    const velocity = new (require('@/lib/services/velocity-client').VelocityClient)({ host: 'proxy', port: 3001 });
    velocity.setBaseUrl(velocityUrl);
    await velocity.registerServer(server.id, server.node.host, server.serverPort);
  } catch (err: any) {
    console.warn(`[server-actions] Failed to register server ${server.id} with Velocity: ${err.message}`);
  }
}

async function unregisterFromVelocity(serverId: string) {
  try {
    const velocityUrl = process.env.VELOCITY_URL || 'http://proxy:3001/api/v1';
    const velocity = new (require('@/lib/services/velocity-client').VelocityClient)({ host: 'proxy', port: 3001 });
    velocity.setBaseUrl(velocityUrl);
    await velocity.unregisterServer(serverId);
  } catch (err: any) {
    console.warn(`[server-actions] Failed to unregister server ${serverId} with Velocity: ${err.message}`);
  }
}

/**
 * Start/stop/restart path for the Discord bot, mirroring the panel's own
 * `/api/servers/[id]/action` route (Velocity registration, DB status updates).
 * Kept separate from that route rather than shared, so a bot-specific change can't
 * accidentally alter the panel's own action handling.
 */
export async function runServerAction(server: ActionableServer, action: LifecycleAction): Promise<{ message: string; status: string }> {
  const daemonClient = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
  const targetContainerId = server.containerId || server.id;

  if (action === 'start' || action === 'restart') {
    const serverMeta = {
      serverId: server.id,
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

    await registerWithVelocity(server);
    await prisma.server.update({ where: { id: server.id }, data: { containerId: targetContainerId, status: 'RUNNING' } });
    return { message: 'Server start/restart command sent', status: 'RUNNING' };
  }

  // stop
  try {
    await daemonClient.stopServer(targetContainerId);
  } catch (e: any) {
    console.warn(`[server-actions] Stop warning: ${e.message}`);
  }
  await unregisterFromVelocity(server.id);
  await prisma.server.update({ where: { id: server.id }, data: { containerId: targetContainerId, status: 'STOPPING' } });
  return { message: 'Server stop command sent', status: 'STOPPING' };
}
