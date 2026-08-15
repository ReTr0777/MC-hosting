import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

/**
 * Proxy for a flat-file ban list (Terraria's `banlist.txt`).
 *
 * Minecraft's structured ban routes are untouched beside this — the daemon
 * decides which shape a server has from its game.
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

    const target = server.containerId || `process-${server.id}`;
    const data = await clientFor(server.node).request(`/servers/${target}/banlist`);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch ban list' }, { status: 500 });
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

    const { unban } = await request.json();

    const target = server.containerId || `process-${server.id}`;
    const data = await clientFor(server.node).request(`/servers/${target}/banlist`, {
      method: 'POST',
      body: JSON.stringify({ unban }),
    });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update ban list' }, { status: 500 });
  }
}
