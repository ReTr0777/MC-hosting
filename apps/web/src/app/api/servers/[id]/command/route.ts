import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { command } = await request.json();
    if (!command || typeof command !== 'string' || !command.trim()) {
      return NextResponse.json({ error: 'Missing command' }, { status: 400 });
    }

    const daemonClient = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });

    const targetContainerId = server.containerId || `process-${server.id}`;
    const data = await daemonClient.sendCommand(targetContainerId, command.trim());

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to send command' }, { status: 500 });
  }
}
