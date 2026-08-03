import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

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
    // Forward raw binary stream directly to daemon without buffering in RAM
    const daemonUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/upload-pack`;
    
    const daemonRes = await fetch(daemonUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${server.node.apiKey}`,
        'Content-Type': 'application/octet-stream',
        ...(req.headers.get('content-length') ? { 'Content-Length': req.headers.get('content-length') as string } : {}),
      },
      // Stream directly to backend
      body: req.body,
      // @ts-ignore - Required for undici streaming fetch
      duplex: 'half',
    });

    if (!daemonRes.ok) {
      const errText = await daemonRes.text();
      throw new Error(`Daemon upload failed (${daemonRes.status}): ${errText}`);
    }

    return NextResponse.json({ message: 'Serverpack ZIP uploaded and extracted successfully' });
  } catch (err: any) {
    console.error('[Web API] Serverpack upload error:', err.message);
    return NextResponse.json({ error: 'Failed to upload serverpack', details: err.message }, { status: 500 });
  }
}
