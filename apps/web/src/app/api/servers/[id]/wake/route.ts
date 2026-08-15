import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { requestWake } from '@/lib/servers/sleep';
import { serverStartBlock } from '@/lib/servers/suspension';

export const dynamic = 'force-dynamic';

/** Wakes a sleeping server. Falls back to a plain start if it wasn't asleep. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const block = await serverStartBlock(server.id);
  if (block) return NextResponse.json({ error: block }, { status: 403 });

  try {
    await requestWake(server.node, server);
    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'STARTING', sleepEmptySince: null, lastWokeAt: new Date() },
    });
    return NextResponse.json({ success: true, message: 'Server is waking up' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to wake server', details: err.message }, { status: 502 });
  }
}
