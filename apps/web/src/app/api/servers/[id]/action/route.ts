import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { ServerType } from '@mc-manager/shared';
import { writeAudit } from '@/lib/audit';
import { serverStartBlock } from '@/lib/servers/suspension';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { action, deleteData } = await req.json();

  if (!action || !['start', 'stop', 'restart', 'kill', 'delete'].includes(action)) {
    return NextResponse.json({ error: 'Invalid or missing action (start, stop, restart, kill, delete)' }, { status: 400 });
  }

  // 1. Fetch server & check permissions
  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: { where: { userId: user.userId } },
    },
  });

  if (!server) {
    if (action === 'delete') {
      return NextResponse.json({ message: 'Server already deleted' });
    }
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const userPermission = server.permissions[0]?.role;
  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';

  // Permission validation
  if (!isGlobalAdmin) {
    if (!userPermission || userPermission === 'VIEWER') {
      return NextResponse.json({ error: 'Forbidden: Insufficient server permissions' }, { status: 403 });
    }

    if (action === 'delete' && userPermission !== 'OWNER') {
      return NextResponse.json({ error: 'Forbidden: Only the server Owner can delete this instance' }, { status: 403 });
    }
  }

  const daemonClient = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });

  const targetContainerId = server.containerId || `process-${server.id}`;

  // A suspended server (or one whose owner is suspended) may still be stopped, killed and
  // deleted — only bringing it back up is blocked.
  if (action === 'start' || action === 'restart') {
    const block = await serverStartBlock(server.id);
    if (block) {
      return NextResponse.json({ error: block }, { status: 403 });
    }
  }

  try {
    if (action === 'start' || action === 'restart') {
      const serverMeta = {
        serverId: server.id,
        // Carried so a start — or the create fallback below — cannot erase which
        // game this server is. See the guard in the daemon's create route.
        game: (server as any).game || undefined,
        gameConfig: (server as any).gameConfig || undefined,
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
        console.warn(`[Web API] Start/Restart failed (${e.message}). Auto-creating container for server ${server.id}...`);
        try {
          await daemonClient.createServer(serverMeta as any);
          await daemonClient.startServer(targetContainerId, serverMeta);
        } catch (createErr: any) {
          if (createErr.message.includes('409')) {
            console.log(`[Web API] Provisioning already in progress for server ${server.id}`);
            return NextResponse.json({ message: 'Server is currently provisioning', status: 'PROVISIONING' });
          }
          throw createErr;
        }
      }

      // Register with Velocity Proxy
      try {
        const velocityUrl = process.env.VELOCITY_URL || 'http://proxy:3001/api/v1';
        const velocity = new (require('@/lib/services/velocity-client').VelocityClient)({ host: 'proxy', port: 3001 });
        velocity.setBaseUrl(velocityUrl);
        await velocity.registerServer(server.id, server.node.host, server.serverPort);
      } catch (velErr: any) {
        console.warn(`[Web API] Failed to register server ${server.id} with Velocity: ${velErr.message}`);
      }

      // STARTING, not RUNNING: all that happened here is that the daemon accepted the command.
      // A modpack can spend many minutes installing and loading before it opens its port, and
      // claiming RUNNING now is what leaves players staring at "Can't connect to server" while
      // the panel insists the server is up. The daemon's boot watchdog and the monitor tick
      // promote this to RUNNING once the server actually answers a ping.
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'STARTING' },
      });
      await writeAudit({
        userId: user.userId,
        action: action === 'restart' ? 'SERVER_RESTART' : 'SERVER_START',
        details: { serverId: server.id, serverName: server.name },
      });
      return NextResponse.json({ message: 'Server start/restart command sent', status: 'STARTING' });
    }

    if (action === 'stop') {
      try {
        await daemonClient.stopServer(targetContainerId);
      } catch (e: any) {
        console.warn(`[Web API] Stop warning: ${e.message}`);
      }
      
      // Unregister from Velocity Proxy
      try {
        const velocityUrl = process.env.VELOCITY_URL || 'http://proxy:3001/api/v1';
        const velocity = new (require('@/lib/services/velocity-client').VelocityClient)({ host: 'proxy', port: 3001 });
        velocity.setBaseUrl(velocityUrl);
        await velocity.unregisterServer(server.id);
      } catch (velErr: any) {
        console.warn(`[Web API] Failed to unregister server ${server.id} with Velocity: ${velErr.message}`);
      }

      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'STOPPING' },
      });
      await writeAudit({ userId: user.userId, action: 'SERVER_STOP', details: { serverId: server.id, serverName: server.name } });
      return NextResponse.json({ message: 'Server stop command sent', status: 'STOPPING' });
    }

    if (action === 'kill') {
      try {
        await daemonClient.killServer(targetContainerId);
      } catch (e: any) {
        console.warn(`[Web API] Kill warning: ${e.message}`);
      }
      
      // Unregister from Velocity Proxy
      try {
        const velocityUrl = process.env.VELOCITY_URL || 'http://proxy:3001/api/v1';
        const velocity = new (require('@/lib/services/velocity-client').VelocityClient)({ host: 'proxy', port: 3001 });
        velocity.setBaseUrl(velocityUrl);
        await velocity.unregisterServer(server.id);
      } catch (velErr: any) {
        console.warn(`[Web API] Failed to unregister server ${server.id} with Velocity: ${velErr.message}`);
      }

      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'OFFLINE' },
      });
      await writeAudit({ userId: user.userId, action: 'SERVER_KILL', details: { serverId: server.id, serverName: server.name } });
      return NextResponse.json({ message: 'Server force killed', status: 'OFFLINE' });
    }

    if (action === 'delete') {
      try {
        await daemonClient.deleteServer(targetContainerId, deleteData, server.id);
      } catch (e) {
        console.warn('[Web API] Daemon delete failed or container missing, removing DB record anyway.');
      }
      try {
        await prisma.server.delete({ where: { id: server.id } });
      } catch (e) {
        // Record was already deleted
      }
      await writeAudit({ userId: user.userId, action: 'SERVER_DELETE', details: { serverId: server.id, serverName: server.name } });
      return NextResponse.json({ message: 'Server instance deleted' });
    }

    return NextResponse.json({ error: 'Unhandled action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: `Failed to execute action ${action}`, details: err.message }, { status: 500 });
  }
}
