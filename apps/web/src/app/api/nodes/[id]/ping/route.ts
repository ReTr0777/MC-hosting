import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const node = await prisma.node.findUnique({
    where: { id: params.id },
  });

  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const client = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

  try {
    const health = await client.getHealth();
    const isOnline = health.status === 'ok' || health.dockerAvailable;

    // Extract primary disk (largest mounted volume)
    const primaryDisk = health.diskUsage
      ?.filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total)[0];

    await prisma.node.update({
      where: { id: node.id },
      data: {
        isOnline,
        // Update totalMemory from live data so Smart Scheduler stays accurate
        ...(health.memoryUsage?.total ? { totalMemory: health.memoryUsage.total } : {}),
        // Live hardware stats
        liveCpuUsage: health.cpuUsage ?? null,
        liveRamUsed: health.memoryUsage?.used ?? null,
        liveRamTotal: health.memoryUsage?.total ?? null,
        liveDiskUsed: primaryDisk?.used ?? null,
        liveDiskTotal: primaryDisk?.total ?? null,
        liveCpuModel: health.cpuModel ?? null,
        liveCpuCores: health.cpuCores ?? null,
        liveOsDistro: health.osInfo?.distro ?? null,
        liveCpuTemp: health.cpuTemp ?? null,
        liveLastSeenAt: new Date(),
      },
    });

    return NextResponse.json({ isOnline, health });
  } catch (err: any) {
    await prisma.node.update({
      where: { id: node.id },
      data: { isOnline: false },
    });

    return NextResponse.json({ isOnline: false, error: err.message }, { status: 502 });
  }
}
