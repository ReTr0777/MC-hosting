import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';
import { allNodeCapacities } from '@/lib/servers/node-capacity';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nodes = await prisma.node.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      host: true,
      port: true,
      isOnline: true,
      totalMemory: true,
      totalCpu: true,
      offloadPriority: true,
      overcommitRatio: true,
      cpuOvercommitRatio: true,
      enabledGames: true,
      liveCpuUsage: true,
      liveRamUsed: true,
      liveRamTotal: true,
      liveDiskUsed: true,
      liveDiskTotal: true,
      liveCpuModel: true,
      liveCpuCores: true,
      liveOsDistro: true,
      liveCpuTemp: true,
      liveLastSeenAt: true,
      createdAt: true,
      _count: {
        select: { servers: true },
      },
    },
  });

  // Live usage says what the box is doing this second; allocation says what it has promised.
  // The second number is the one that decides whether the next server fits.
  const capacities = await allNodeCapacities();

  return NextResponse.json({
    nodes: nodes.map((node) => ({ ...node, capacity: capacities.get(node.id) ?? null })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  try {
    const { name, host, port, apiKey, totalMemory, totalCpu } = await req.json();

    if (!name || !host || !apiKey) {
      return NextResponse.json({ error: 'Name, host, and apiKey are required' }, { status: 400 });
    }

    // Ping node to verify connection
    const client = new DaemonClient({ host, port: port || 3500, apiKey });
    let isOnline = false;
    let health: any = null;

    try {
      // A node registered over a tunnel deserves the same patience as one being polled.
      health = await client.getHealth(DaemonClient.HEALTH_TIMEOUT_MS);
      isOnline = health.status === 'ok' || health.dockerAvailable;
    } catch (e) {
      isOnline = false;
    }

    // Capacity has to describe the real machine, otherwise the allocation checks refuse servers a
    // node could easily hold. Prefer what the admin typed, then what the daemon reports about
    // itself, and only fall back to a placeholder when the node answered nothing at all.
    const detectedMemory = Number(health?.memoryUsage?.total);
    const detectedCpu = Number(health?.cpuCores);

    const node = await prisma.node.create({
      data: {
        name,
        host,
        port: port || 3500,
        apiKey,
        isOnline,
        totalMemory: Number(totalMemory) || (detectedMemory > 0 ? detectedMemory : 8192),
        totalCpu: Number(totalCpu) || (detectedCpu > 0 ? detectedCpu : 4),
      },
    });

    await writeAudit({ userId: user.userId, action: 'NODE_CREATE', details: { nodeId: node.id, name: node.name, host: node.host } });

    return NextResponse.json({ message: 'Node registered successfully', node }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to create node', details: err.message }, { status: 500 });
  }
}
