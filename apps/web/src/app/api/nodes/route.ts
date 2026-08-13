import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { writeAudit } from '@/lib/audit';

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

  return NextResponse.json({ nodes });
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

    try {
      const health = await client.getHealth();
      isOnline = health.status === 'ok' || health.dockerAvailable;
    } catch (e) {
      isOnline = false;
    }

    const node = await prisma.node.create({
      data: {
        name,
        host,
        port: port || 3500,
        apiKey,
        isOnline,
        totalMemory: totalMemory || 8192,
        totalCpu: totalCpu || 4,
      },
    });

    await writeAudit({ userId: user.userId, action: 'NODE_CREATE', details: { nodeId: node.id, name: node.name, host: node.host } });

    return NextResponse.json({ message: 'Node registered successfully', node }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to create node', details: err.message }, { status: 500 });
  }
}
