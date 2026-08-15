import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

/**
 * Proxy for the daemon's game-agnostic config-file routes.
 *
 * A copy of the `/properties` pair beside it rather than a generalisation of it —
 * `/properties` is what the Minecraft Settings tab uses today and is left exactly
 * as it was. The daemon resolves which file this actually edits from the server's
 * game, so nothing here needs to know the filename.
 */

function clientFor(node: { host: string; port: number; apiKey: string }) {
  return new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await clientFor(server.node).request<{ file: string; properties: Record<string, string> }>(
      `/servers/${targetContainerId}/gameconfig`
    );
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch game config' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { properties } = await request.json();

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await clientFor(server.node).request<{ success: boolean; file: string; message: string }>(
      `/servers/${targetContainerId}/gameconfig`,
      { method: 'POST', body: JSON.stringify({ properties }) }
    );

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update game config' }, { status: 500 });
  }
}
