import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';

async function getDaemonClient(nodeId: string) {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return null;
  return new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  try {
    const client = await getDaemonClient(params.id);
    if (!client) return NextResponse.json({ error: 'Node not found' }, { status: 404 });

    const config = await client.getBackupStorageConfig();
    return NextResponse.json({ config });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch backup storage config', details: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  try {
    const client = await getDaemonClient(params.id);
    if (!client) return NextResponse.json({ error: 'Node not found' }, { status: 404 });

    const body = await req.json();
    const result = await client.setBackupStorageConfig(body);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to save backup storage config', details: err.message }, { status: 500 });
  }
}
