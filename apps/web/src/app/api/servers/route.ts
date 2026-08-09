import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { ServerType, ExecutionMode } from '@mc-manager/shared';

export async function GET(req: NextRequest) {
  try {
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
  } catch (err: any) {
    console.error('[Web API /servers GET] Error:', err.message || err);
    return NextResponse.json({ error: 'Failed to fetch servers', details: err.message || 'Unknown error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  console.log(`[Web API /servers POST] ===== REQUEST STARTED =====`);
  let payload: any = null;
  
  try {
    // Log the request for debugging
    const contentType = req.headers.get('content-type');
    const contentLength = req.headers.get('content-length');
    console.log(`[Web API /servers POST] Content-Type: ${contentType}, Content-Length: ${contentLength}`);

    // Check if request has proper headers
    if (!contentType?.includes('application/json')) {
      console.warn(`[Web API /servers POST] Warning: Content-Type is ${contentType}, expected application/json`);
    }

    let bodyText = '';
    try {
      bodyText = await req.text();
      console.log(`[Web API /servers POST] Raw body received, length: ${bodyText.length} chars`);
      
      if (!bodyText || bodyText.length === 0) {
        console.error('[Web API /servers POST] Body is empty!');
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 });
      }

      console.log(`[Web API /servers POST] First 100 chars of body: ${bodyText.substring(0, 100)}`);
      payload = JSON.parse(bodyText);
      console.log(`[Web API /servers POST] Successfully parsed JSON payload`);
    } catch (bodyErr: any) {
      console.error('[Web API /servers POST] ❌ CRITICAL ERROR reading/parsing body');
      console.error('[Web API /servers POST] Error type:', bodyErr.constructor.name);
      console.error('[Web API /servers POST] Error message:', bodyErr.message);
      console.error('[Web API /servers POST] Error stack:', bodyErr.stack);
      console.error('[Web API /servers POST] Body text length:', bodyText.length);
      if (bodyText.length > 0) {
        console.error('[Web API /servers POST] First 300 chars:', bodyText.substring(0, 300));
      }
      return NextResponse.json({ 
        error: 'Failed to parse request body', 
        details: bodyErr.message,
        bodyLength: bodyText.length
      }, { status: 400 });
    }

    console.log(`[Web API /servers POST] ✓ Body parsed successfully`);

    console.log(`[Web API /servers POST] Now authenticating user...`);
    let user: any;
    try {
      user = await getUserFromRequest(req);
      if (!user) {
        console.warn(`[Web API /servers POST] ❌ No user found in request`);
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      console.log(`[Web API /servers POST] ✓ User authenticated: ${user.userId}`);
    } catch (authErr: any) {
      console.error('[Web API /servers POST] ❌ ERROR during authentication');
      console.error('[Web API /servers POST] Auth error:', authErr.message);
      console.error('[Web API /servers POST] Auth error stack:', authErr.stack);
      return NextResponse.json({ 
        error: 'Failed to authenticate user', 
        details: authErr.message 
      }, { status: 401 });
    }

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
    } = payload;

    console.log(`[Web API /servers POST] ✓ Extracted params - name: ${name}, serverType: ${serverType}, eulaAccepted: ${eulaAccepted}`);

    if (!name || typeof name !== 'string') {
      console.error('[Web API /servers POST] ❌ Invalid name:', name);
      return NextResponse.json({ error: 'Server name is required and must be a string' }, { status: 400 });
    }

    if (!eulaAccepted) {
      console.error('[Web API /servers POST] ❌ EULA not accepted');
      return NextResponse.json({ error: 'EULA must be accepted before creating a server' }, { status: 400 });
    }

    const reqMemoryMb = parseInt(memoryMb, 10);
    if (isNaN(reqMemoryMb) || reqMemoryMb < 512) {
      console.error('[Web API /servers POST] ❌ Invalid memory:', memoryMb);
      return NextResponse.json({ error: 'Memory must be at least 512 MB' }, { status: 400 });
    }

    console.log(`[Web API /servers POST] ✓ All parameters validated`);
    let targetNodeId = nodeId;

    // Smart Node Scheduler: Auto-select node if nodeId is missing or set to 'AUTO'
    if (!targetNodeId || targetNodeId === 'AUTO') {
      console.log(`[Web API /servers POST] Starting smart node scheduler...`);
      try {
        const onlineNodes = await prisma.node.findMany({
          where: { isOnline: true },
          include: {
            servers: {
              select: { memoryMb: true, status: true },
            },
          },
        });

        if (onlineNodes.length === 0) {
          console.error('[Web API /servers POST] ❌ No online nodes found');
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
          console.warn(`[Web API /servers POST] ⚠ No eligible nodes, using fallback: ${selectedNodeItem.node.name} (${selectedNodeItem.availableMemoryMb}MB available)`);
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
          console.log(`[Web API /servers POST] ✓ Selected node: ${selectedNodeItem.node.name} (Priority: ${selectedNodeItem.offloadPriority}, Avail Memory: ${selectedNodeItem.availableMemoryMb}MB)`);
        }
      } catch (schedulerErr: any) {
        console.error('[Web API /servers POST] ❌ ERROR in smart scheduler');
        console.error('[Web API /servers POST] Scheduler error:', schedulerErr.message);
        console.error('[Web API /servers POST] Scheduler error stack:', schedulerErr.stack);
        return NextResponse.json({ 
          error: 'Smart scheduler failed', 
          details: schedulerErr.message 
        }, { status: 500 });
      }
    }

    console.log(`[Web API /servers POST] Fetching target node: ${targetNodeId}`);
    let node: any;
    try {
      node = await prisma.node.findUnique({
        where: { id: targetNodeId },
      });

      if (!node) {
        console.error('[Web API /servers POST] ❌ Node not found:', targetNodeId);
        return NextResponse.json({ error: 'Target node not found' }, { status: 404 });
      }
      console.log(`[Web API /servers POST] ✓ Found node: ${node.name}`);
    } catch (nodeErr: any) {
      console.error('[Web API /servers POST] ❌ ERROR fetching node');
      console.error('[Web API /servers POST] Node error:', nodeErr.message);
      console.error('[Web API /servers POST] Node error stack:', nodeErr.stack);
      return NextResponse.json({ 
        error: 'Failed to fetch node', 
        details: nodeErr.message 
      }, { status: 500 });
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
    console.log(`[Web API /servers POST] ✓ Allocated port: ${allocatedPort}`);

    // 1. Create Server record in database
    console.log(`[Web API /servers POST] Creating server in database...`);
    let server: any;
    try {
      server = await prisma.server.create({
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
      console.log(`[Web API /servers POST] ✓ Server created in DB: ${server.id}`);
    } catch (dbErr: any) {
      console.error('[Web API /servers POST] ❌ ERROR creating server in database');
      console.error('[Web API /servers POST] DB error:', dbErr.message);
      console.error('[Web API /servers POST] DB error stack:', dbErr.stack);
      return NextResponse.json({ 
        error: 'Failed to create server in database', 
        details: dbErr.message 
      }, { status: 500 });
    }

    // 2. Dispatch server creation to selected Daemon node
    console.log(`[Web API /servers POST] Dispatching server creation to daemon: ${node.host}:${node.port}`);
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
      console.log(`[Web API /servers POST] ✓ Server successfully created on daemon`);
    } catch (daemonErr: any) {
      console.error('[Web API /servers POST] ⚠ Daemon create server failed (not critical):', daemonErr.message);
      await prisma.server.update({
        where: { id: server.id },
        data: { status: 'ERROR' },
      });

      return NextResponse.json(
        {
          message: 'Server record created, but Daemon failed to spin up container',
          server: JSON.parse(JSON.stringify(server)),
          daemonError: daemonErr.message,
        },
        { status: 207 }
      );
    }

    console.log(`[Web API /servers POST] ===== REQUEST COMPLETED SUCCESSFULLY =====`);
    return NextResponse.json({ 
      message: 'Server created successfully', 
      server: JSON.parse(JSON.stringify(server)),
      nodeName: node.name 
    }, { status: 201 });
  } catch (err: any) {
    console.error(`[Web API /servers POST] ===== UNCAUGHT ERROR =====`);
    console.error('[Web API /servers POST] Error type:', err?.constructor?.name);
    console.error('[Web API /servers POST] Error message:', err?.message);
    console.error('[Web API /servers POST] Error stack:', err?.stack);
    const errorMsg = err?.message || err?.toString() || 'Unknown error occurred';
    return NextResponse.json({ error: 'Failed to create server', details: errorMsg }, { status: 500 });
  }
}

