import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { ServerType, ExecutionMode } from '@mc-manager/shared';

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
      executionMode = 'PROCESS',
      mcVersion = '26.2',
      serverPort = 24000,
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

      // Calculate capacity per node and filter eligible nodes (only active RUNNING/STARTING servers consume active node RAM)
      const nodeCapacities = onlineNodes.map((node: any) => {
        const activeServers = node.servers.filter((s: any) => s.status === 'RUNNING' || s.status === 'STARTING' || s.status === 'RESTARTING');
        const usedMemoryMb = activeServers.reduce((sum: number, s: any) => sum + s.memoryMb, 0);
        const nodeTotalRam = node.totalMemory && node.totalMemory > 0 ? node.totalMemory : 65536;
        const availableMemoryMb = Math.max(0, nodeTotalRam - usedMemoryMb);
        return {
          node,
          usedMemoryMb,
          availableMemoryMb,
          offloadPriority: node.offloadPriority,
        };
      });

      const eligibleNodes = nodeCapacities.filter((item: any) => item.availableMemoryMb >= reqMemoryMb);

      let selectedNodeItem: any;
      if (eligibleNodes.length === 0) {
        // Fallback to highest available node if tight on RAM instead of hard erroring
        nodeCapacities.sort((a: any, b: any) => b.availableMemoryMb - a.availableMemoryMb);
        selectedNodeItem = nodeCapacities[0];
        targetNodeId = selectedNodeItem.node.id;
      } else {
        // Sort by offloadPriority (descending - highest offload priority first), then by available memory
        eligibleNodes.sort((a: any, b: any) => {
          if (b.offloadPriority !== a.offloadPriority) {
            return b.offloadPriority - a.offloadPriority;
          }
          return b.availableMemoryMb - a.availableMemoryMb;
        });
        selectedNodeItem = eligibleNodes[0];
        targetNodeId = selectedNodeItem.node.id;
      }
      console.log(
        `[Smart Scheduler] Assigned server "${name}" to Node "${selectedNodeItem.node.name}" (Priority: ${selectedNodeItem.offloadPriority}, Avail Memory: ${selectedNodeItem.availableMemoryMb}MB)`
      );
    }

    const node = await prisma.node.findUnique({
      where: { id: targetNodeId },
    });

    if (!node) {
      return NextResponse.json({ error: 'Target node not found' }, { status: 404 });
    }

    // Auto-allocate unique Minecraft server port starting from 24000
    let allocatedPort = parseInt(serverPort, 10);
    if (!allocatedPort || isNaN(allocatedPort)) {
      allocatedPort = 24000;
    }
    const existingPorts = (await prisma.server.findMany({ select: { serverPort: true } })).map((s: any) => s.serverPort);
    while (existingPorts.includes(allocatedPort)) {
      allocatedPort++;
    }

    // 1. Create Server record in database
    const server = await prisma.server.create({
      data: {
        name,
        description,
        nodeId: node.id,
        serverType: serverType as any,
        executionMode: executionMode as any,
        mcVersion,
        serverPort: allocatedPort,
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

    // 2. Dispatch server creation to selected Daemon node
    const daemonClient = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

    try {
      const containerResult = await daemonClient.createServer({
        serverId: server.id,
        serverType: server.serverType as ServerType,
        executionMode: server.executionMode as ExecutionMode,
        mcVersion: server.mcVersion,
        modpackSlug: server.modpackSlug || undefined,
        serverPort: server.serverPort,
        memoryMb: server.memoryMb,
        cpuLimit: server.cpuLimit,
        eulaAccepted: true,
      });

      // Update server with container ID or process ID
      await prisma.server.update({
        where: { id: server.id },
        data: { containerId: containerResult.containerId },
      });
    } catch (daemonErr: any) {
      console.error('[Web API] Daemon create server failed:', daemonErr.message);
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
