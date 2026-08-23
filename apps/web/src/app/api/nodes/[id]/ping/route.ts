import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { isHealthOnline } from '@/lib/services/node-status';
import { parseGameList } from '@mc-manager/shared';
import { canSeeNode } from '@/lib/servers/node-access';
import { reportedCapacityPatch } from '@/lib/nodes/reported-capacity';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const node = await prisma.node.findUnique({
    where: { id: params.id },
  });

  // The dashboard polls every node it lists, so this follows the same visibility rule the
  // list does — otherwise a stranger's machine could be probed by id alone.
  if (!node || !canSeeNode(user, node)) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const client = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

  try {
    // Generous on purpose: this poll decides the online badge, and a remote node
    // answering slowly is not the same as a node that is down.
    const health = await client.getHealth(DaemonClient.HEALTH_TIMEOUT_MS);
    const isOnline = isHealthOnline(health);

    const reportedGames = parseGameList(health.enabledGames);

    // Extract primary disk (largest mounted volume)
    const primaryDisk = health.diskUsage
      ?.filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total)[0];

    await prisma.node.update({
      where: { id: node.id },
      data: {
        isOnline,
        // Capacity from live data so Smart Scheduler stays accurate — the node's own
        // allowance when it caps itself, its hardware otherwise.
        ...reportedCapacityPatch(health),
        // A daemon older than this field reports nothing, which must mean "leave the
        // stored list alone" — writing an empty array would hide the node from the
        // create wizard entirely, every 5 seconds, with no way for the operator to see why.
        ...(reportedGames ? { enabledGames: reportedGames } : {}),
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
        liveJavaMajor: health.javaMajor ?? null,
        liveDataDiskFreeMb: health.dataDiskFreeMb ?? null,
        liveDaemonVersion: health.version ?? null,
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
