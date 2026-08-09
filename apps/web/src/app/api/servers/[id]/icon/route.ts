import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true },
  });

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  try {
    const daemonUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/icon`;
    const daemonRes = await fetch(daemonUrl, {
      headers: {
        'Authorization': `Bearer ${server.node.apiKey}`,
      },
      next: { revalidate: 30 },
    });

    if (!daemonRes.ok) {
      return NextResponse.json({ error: 'Icon not found' }, { status: 404 });
    }

    const imageBuffer = await daemonRes.arrayBuffer();
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch icon' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true },
  });

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  try {
    const daemonUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/icon`;
    
    const daemonRes = await fetch(daemonUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${server.node.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body: req.body,
      // @ts-ignore
      duplex: 'half',
    });

    if (!daemonRes.ok) {
      const errText = await daemonRes.text();
      throw new Error(`Daemon icon upload failed (${daemonRes.status}): ${errText}`);
    }

    return NextResponse.json({ message: 'Server icon updated successfully' });
  } catch (err: any) {
    console.error('[Web API] Icon upload error:', err.message);
    return NextResponse.json({ error: 'Failed to upload icon', details: err.message }, { status: 500 });
  }
}
