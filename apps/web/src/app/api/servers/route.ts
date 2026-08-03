import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { ServerType } from '@mc-manager/shared';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let servers;
  if (user.globalRole === 'GLOBAL_ADMIN') {
    servers = await prisma.server.findMany({
      include: {
        node: { select: { id: true, name: true, host: true, port: true, isOnline: true, offloadPriority: true } },
        permissions: {
          include: { user: { select: { id: true, username: true, email: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  } else {
    servers = await prisma.server.findMany({
      where: {
        permissions: {
          some: { userId: user.userId },
        },
      },
      include: {
        node: { select: { id: true, name: true, host: true, port: true, isOnline: true, offloadPriority: true } },
        permissions: {
          where: { userId: user.userId },
          select: { role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  return NextResponse.json({ servers });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const {
      name,
      description,
      nodeId,
      serverType = 'FABRIC',
      mcVersion = '1.20.1',
      serverPort = 25565,
      modpackSlug,
      memoryMb = 8192,
      cpuLimit = 1.0,
      eulaAccepted = false,
    } = await req.json();

    if (!name) {
      return NextResponse.json({ error: 'Server name is required' }, { status: 400 });
    }

    if (!eulaAccepted) {
      return NextResponse.json({ error: 'EULA must be accepted before creating a server' }, { status: 400 });
    }

    const reqMemoryMb = parseInt(memoryMb, 10);
    let targetNodeId = nodeId;

    // Smart Node Scheduler: Auto-select node if nodeId is missing or set to 'AUTO'
    if (!targetNodeId || targetNodeId === 'AUTO') {
      const onlineNodes = await prisma.node.findMany({
        where: { isOnline: true },
        include: {
          servers: {
            select: { memoryMb: true, status: true },
          },
        },
      });

      if (onlineNodes.length === 0) {
        return NextResponse.json(
          { error: 'Smart Scheduler Error: No online daemon worker nodes are registered or reachable.' },
          { status: 503 }
        );
      }

      // Calculate capacity per node and filter eligible nodes
      const nodeCapacities = onlineNodes.map((node) => {
        const usedMemoryMb = node.servers.reduce((sum, s) => sum + s.memoryMb, 0);
        const availableMemoryMb = node.totalMemory - usedMemoryMb;
        return {
          node,
          usedMemoryMb,
          availableMemoryMb,
          offloadPriority: node.offloadPriority,
        };
      });

      const eligibleNodes = nodeCapacities.filter((item) => item.availableMemoryMb >= reqMemoryMb);

      if (eligibleNodes.length === 0) {
        return NextResponse.json(
          {
            error: `Smart Scheduler Capacity Exceeded: None of the ${onlineNodes.length} online nodes have enough free memory (Requested: ${reqMemoryMb} MB).`,
          },
          { status: 400 }
        );
      }

      // Sort by offloadPriority (descending - highest offload priority first), then by available memory
      eligibleNodes.sort((a, b) => {
        if (b.offloadPriority !== a.offloadPriority) {
          return b.offloadPriority - a.offloadPriority;
        }
        return b.availableMemoryMb - a.availableMemoryMb;
      });

      targetNodeId = eligibleNodes[0].node.id;
      console.log(
        `[Smart Scheduler] Assigned server "${name}" to Node "${eligibleNodes[0].node.name}" (Priority: ${eligibleNodes[0].offloadPriority}, Avail Memory: ${eligibleNodes[0].availableMemoryMb}MB)`
      );
    }

    const node = await prisma.node.findUnique({
      where: { id: targetNodeId },
    });

    if (!node) {
      return NextResponse.json({ error: 'Target node not found' }, { status: 404 });
    }

    // 1. Create Server record in database
    const server = await prisma.server.create({
      data: {
        name,
        description,
        nodeId: node.id,
        serverType: serverType as any,
        mcVersion,
        serverPort: parseInt(serverPort, 10),
        modpackSlug: (serverType === 'MODRINTH' || serverType === 'CURSEFORGE') ? modpackSlug : null,
        eulaAccepted: true,
        memoryMb: reqMemoryMb,
        cpuLimit: parseFloat(cpuLimit),
        status: 'OFFLINE',
        permissions: {
          create: {
            userId: user.userId,
            role: 'OWNER',
          },
        },
      },
    });

    // 2. Dispatch container creation to selected Daemon node
    const daemonClient = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

    try {
      const containerResult = await daemonClient.createServer({
        serverId: server.id,
        serverType: server.serverType as ServerType,
        mcVersion: server.mcVersion,
        modpackSlug: server.modpackSlug || undefined,
        serverPort: server.serverPort,
        memoryMb: server.memoryMb,
        cpuLimit: server.cpuLimit,
        eulaAccepted: true,
      });

      // Update server with container ID
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: containerResult.containerId },
      });
    } catch (daemonErr: any) {
      console.error('[Web API] Daemon create container failed:', daemonErr.message);
      await prisma.server.update({
        where: { id: server.id },
        data: { status: 'ERROR' },
      });

      return NextResponse.json(
        {
          message: 'Server record created, but Daemon failed to spin up container',
          server,
          daemonError: daemonErr.message,
        },
        { status: 207 }
      );
    }

    return NextResponse.json({ message: 'Server created successfully', server, nodeName: node.name }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to create server', details: err.message }, { status: 500 });
  }
}
