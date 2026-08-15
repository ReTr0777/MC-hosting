import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { ServerType, ExecutionMode, Game, GAME_LABELS, isGame, parseTerrariaConfig } from '@mc-manager/shared';
import { writeAudit } from '@/lib/audit';
import { quotaSnapshot, quotaViolation } from '@/lib/servers/quota';
import { computeCapacity, capacityViolation, nodeCapacity } from '@/lib/servers/node-capacity';

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
      game,
      gameConfig,
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

    // Absent means Minecraft, so every existing caller — the wizard, the Discord bot,
    // any direct API user — keeps working unchanged.
    const targetGame: Game = isGame(game) ? game : Game.MINECRAFT;

    // The EULA is Mojang's. Requiring it of a Terraria server would be asking the
    // user to agree to a licence that has nothing to do with what they are creating.
    // For Minecraft this is exactly the check that was here before.
    if (targetGame === Game.MINECRAFT && !eulaAccepted) {
      console.error('[Web API /servers POST] ❌ EULA not accepted');
      return NextResponse.json({ error: 'EULA must be accepted before creating a server' }, { status: 400 });
    }

    // Validated here rather than trusted from the client: the wizard is not a
    // security boundary, and an incomplete Terraria config leaves the server
    // hanging at an interactive prompt with no output to diagnose it from.
    const targetGameConfig = targetGame === Game.TERRARIA ? parseTerrariaConfig(gameConfig) : null;

    const reqMemoryMb = parseInt(memoryMb, 10);
    if (isNaN(reqMemoryMb) || reqMemoryMb < 512) {
      console.error('[Web API /servers POST] ❌ Invalid memory:', memoryMb);
      return NextResponse.json({ error: 'Memory must be at least 512 MB' }, { status: 400 });
    }

    console.log(`[Web API /servers POST] ✓ All parameters validated`);

    // Enforce per-user resource quotas (GLOBAL_ADMIN is exempt, which quotaSnapshot handles).
    // The same check runs when a server is resized — see lib/quota.ts.
    {
      const snapshot = await quotaSnapshot(user.userId);
      const violation = quotaViolation(snapshot, {
        memoryMb: reqMemoryMb,
        cpuLimit: parseFloat(cpuLimit) || 1.0,
        countsAsNew: true,
      });
      if (violation) {
        return NextResponse.json({ error: violation }, { status: 403 });
      }
    }

    let targetNodeId = nodeId;

    // Smart Node Scheduler: Auto-select node if nodeId is missing or set to 'AUTO'
    if (!targetNodeId || targetNodeId === 'AUTO') {
      console.log(`[Web API /servers POST] Starting smart node scheduler...`);
      try {
        const allOnlineNodes = await prisma.node.findMany({
          where: { isOnline: true },
          include: {
            servers: {
              select: { id: true, memoryMb: true, cpuLimit: true, status: true },
            },
          },
        });

        if (allOnlineNodes.length === 0) {
          console.error('[Web API /servers POST] ❌ No online nodes found');
          return NextResponse.json(
            { error: 'Smart Scheduler Error: No online daemon worker nodes are registered or reachable.' },
            { status: 503 }
          );
        }

        // Capability filter runs *before* capacity ranking: a node with all the room in
        // the world is still the wrong answer if it does not host this game.
        const onlineNodes = allOnlineNodes.filter((node: any) => node.enabledGames?.includes(targetGame));

        if (onlineNodes.length === 0) {
          return NextResponse.json(
            {
              error:
                `No online node is configured to host ${GAME_LABELS[targetGame]}. ` +
                'Enable it in the node\'s daemon setup page, then try again.',
            },
            { status: 503 }
          );
        }

        // Capacity is measured against *allocated* RAM, not just what happens to be running.
        // Scheduling by active RAM lets a node accept far more servers than it can ever run at
        // once — everything fits right up until the day they all start. See lib/node-capacity.ts.
        const nodeCapacities = onlineNodes.map((node: any) => {
          const capacity = computeCapacity(node, node.servers);
          return {
            node,
            capacity,
            // A node registered without a usable total has no ceiling to schedule against.
            availableMemoryMb: capacity.freeMemoryMb ?? Number.MAX_SAFE_INTEGER,
            offloadPriority: node.offloadPriority,
          };
        });

        const eligibleNodes = nodeCapacities.filter(
          (item: any) => !capacityViolation(item.capacity, { memoryMb: reqMemoryMb, cpuLimit: parseFloat(cpuLimit) || 1.0 })
        );

        let selectedNodeItem: any;
        if (eligibleNodes.length === 0) {
          // No fallback any more: placing the server anyway is exactly the overcommit this is
          // meant to prevent. Raising a node's overcommitRatio is the deliberate way to say yes.
          const roomiest = [...nodeCapacities].sort((a: any, b: any) => b.availableMemoryMb - a.availableMemoryMb)[0];
          return NextResponse.json(
            {
              error:
                `No node has room for a ${reqMemoryMb} MB / ${parseFloat(cpuLimit) || 1.0} core server. ` +
                `The roomiest is "${roomiest.node.name}" with ${roomiest.capacity.freeMemoryMb ?? 0} MB free. ` +
                'Free up space, add a node, or raise a node\'s overcommit ratio.',
            },
            { status: 507 }
          );
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

      // The create wizard's dropdown already hides nodes that cannot host this game, but a
      // dropdown is not a security boundary — the Discord bot and any direct API caller
      // reach this route too.
      if (!node.enabledGames?.includes(targetGame)) {
        return NextResponse.json(
          { error: `Node "${node.name}" is not configured to host ${GAME_LABELS[targetGame]}.` },
          { status: 400 }
        );
      }

      // Also checked for an explicitly chosen node, which never went through the scheduler above.
      const capacity = await nodeCapacity(node.id);
      const overCapacity = capacity && capacityViolation(capacity, {
        memoryMb: reqMemoryMb,
        cpuLimit: parseFloat(cpuLimit) || 1.0,
      });
      if (overCapacity) {
        return NextResponse.json({ error: overCapacity }, { status: 507 });
      }
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
          game: targetGame as any,
          gameConfig: targetGameConfig as any,
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
        game: server.game as Game,
        gameConfig: (server.gameConfig as any) || undefined,
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
    await writeAudit({
      userId: user.userId,
      action: 'SERVER_CREATE',
      details: { serverId: server.id, name: server.name, serverType: server.serverType, mcVersion: server.mcVersion, nodeId: node.id },
    });
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

