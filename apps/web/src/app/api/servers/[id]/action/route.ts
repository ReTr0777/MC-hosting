import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { ServerType } from '@mc-manager/shared';

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

  const targetContainerId = server.containerId || server.id;

  try {
    if (action === 'start' || action === 'restart') {
      try {
        if (action === 'restart') {
          await daemonClient.restartServer(targetContainerId);
        } else {
          await daemonClient.startServer(targetContainerId);
        }
      } catch (e: any) {
        console.warn(`[Web API] Start/Restart failed (${e.message}). Auto-creating container for server ${server.id}...`);
        try {
          await daemonClient.createServer({
            serverId: server.id,
            serverType: server.serverType as ServerType,
            mcVersion: server.mcVersion,
            modpackSlug: server.modpackSlug || undefined,
            serverPort: server.serverPort,
            memoryMb: server.memoryMb,
            cpuLimit: server.cpuLimit,
            eulaAccepted: true,
          });
          // Note: startServerContainer is automatically called by the Daemon's background provisioning, so we don't need to manually call startServer here anymore if createServer succeeded
        } catch (createErr: any) {
          if (createErr.message.includes('409')) {
            console.log(`[Web API] Provisioning already in progress for server ${server.id}`);
            return NextResponse.json({ message: 'Server is currently provisioning', status: 'PROVISIONING' });
          }
          throw createErr;
        }
      }
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'RUNNING' },
      });
      return NextResponse.json({ message: 'Server start/restart command sent', status: 'RUNNING' });
    }

    if (action === 'stop') {
      try {
        await daemonClient.stopServer(targetContainerId);
      } catch (e: any) {
        console.warn(`[Web API] Stop warning: ${e.message}`);
      }
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'STOPPING' },
      });
      return NextResponse.json({ message: 'Server stop command sent', status: 'STOPPING' });
    }

    if (action === 'kill') {
      try {
        await daemonClient.killServer(targetContainerId);
      } catch (e: any) {
        console.warn(`[Web API] Kill warning: ${e.message}`);
      }
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: targetContainerId, status: 'OFFLINE' },
      });
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
      return NextResponse.json({ message: 'Server instance deleted' });
    }

    return NextResponse.json({ error: 'Unhandled action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: `Failed to execute action ${action}`, details: err.message }, { status: 500 });
  }
}
