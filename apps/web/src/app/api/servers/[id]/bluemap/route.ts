import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

export const dynamic = 'force-dynamic';

/** Container port BlueMap binds to inside Docker; published to Server.bluemapPort on the host. */
const CONTAINER_BLUEMAP_PORT = 8100;

async function loadServer(id: string) {
  return prisma.server.findUnique({ where: { id }, include: { node: true } });
}

function clientFor(node: { host: string; port: number; apiKey: string }) {
  return new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });
}

/** Picks a free host port for the map, avoiding both game ports and other map ports. */
async function allocateBluemapPort(): Promise<number> {
  const [servers, taken] = await Promise.all([
    prisma.server.findMany({ select: { serverPort: true } }),
    prisma.server.findMany({ where: { bluemapPort: { not: null } }, select: { bluemapPort: true } }),
  ]);

  const used = new Set<number>([
    ...servers.map((s) => s.serverPort),
    ...taken.map((s) => s.bluemapPort as number),
  ]);

  let port = 28100;
  while (used.has(port)) port++;
  return port;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await loadServer(params.id);
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const isProcessMode = targetContainerId.startsWith('process-');

    let daemonState: any = { supported: null, installed: false };
    try {
      const query = new URLSearchParams({ serverType: server.serverType });
      daemonState = await clientFor(server.node).request(
        `/servers/${targetContainerId}/bluemap?${query}`
      );
    } catch (err: any) {
      daemonState = { supported: null, installed: false, daemonError: err.message };
    }

    const shares = await prisma.mapShare.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
    });

    // A Docker container only exposes the map if it was created with the port published
    const portPublished = isProcessMode ? true : daemonState.configuredPort != null && server.bluemapPort != null;

    return NextResponse.json({
      ...daemonState,
      bluemapPort: server.bluemapPort,
      bluemapEnabled: server.bluemapEnabled,
      isProcessMode,
      needsContainerRebuild: !isProcessMode && server.bluemapPort != null && !portPublished,
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        label: s.label,
        enabled: s.enabled,
        expiresAt: s.expiresAt,
        hasPassword: !!s.passwordHash,
        viewCount: s.viewCount,
        lastViewedAt: s.lastViewedAt,
        createdAt: s.createdAt,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to read BlueMap status' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await loadServer(params.id);
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { action } = await request.json();
    const targetContainerId = server.containerId || `process-${server.id}`;
    const isProcessMode = targetContainerId.startsWith('process-');
    const client = clientFor(server.node);

    if (action === 'install') {
      const hostPort = server.bluemapPort || (await allocateBluemapPort());
      // Docker publishes 8100 -> hostPort; a bare process must bind the host port itself
      const internalPort = isProcessMode ? hostPort : CONTAINER_BLUEMAP_PORT;

      const result = await client.request<any>(`/servers/${targetContainerId}/bluemap/install`, {
        method: 'POST',
        body: JSON.stringify({
          serverType: server.serverType,
          mcVersion: server.mcVersion,
          port: internalPort,
        }),
      });

      await prisma.server.update({
        where: { id: server.id },
        data: { bluemapPort: hostPort, bluemapEnabled: true },
      });

      return NextResponse.json({
        ...result,
        hostPort,
        needsContainerRebuild: !isProcessMode,
      });
    }

    if (action === 'uninstall') {
      const result = await client.request<any>(`/servers/${targetContainerId}/bluemap`, {
        method: 'DELETE',
        body: JSON.stringify({ serverType: server.serverType }),
      });

      await prisma.server.update({ where: { id: server.id }, data: { bluemapEnabled: false } });
      return NextResponse.json(result);
    }

    if (action === 'rebuild-container') {
      if (isProcessMode) {
        return NextResponse.json({ success: true, skipped: true, message: 'Process-mode servers need no rebuild.' });
      }
      if (server.status === 'RUNNING' || server.status === 'STARTING') {
        return NextResponse.json(
          { error: 'Stop the server before rebuilding its container.' },
          { status: 409 }
        );
      }

      const hostPort = server.bluemapPort || (await allocateBluemapPort());
      const result = await client.request<any>(`/servers/${targetContainerId}/recreate-container`, {
        method: 'POST',
        body: JSON.stringify({ bluemapPort: hostPort }),
      });

      await prisma.server.update({
        where: { id: server.id },
        data: { bluemapPort: hostPort, ...(result.containerId ? { containerId: result.containerId } : {}) },
      });

      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unsupported action '${action}'` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'BlueMap action failed' }, { status: 500 });
  }
}
