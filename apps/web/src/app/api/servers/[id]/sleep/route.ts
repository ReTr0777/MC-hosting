import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { getSleepStatus, requestSleep, cancelSleep } from '@/lib/sleep';

export const dynamic = 'force-dynamic';

async function loadServer(id: string) {
  return prisma.server.findUnique({ where: { id }, include: { node: true } });
}

/** Current sleep state plus the configured policy. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await loadServer(params.id);
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  let daemon: any = null;
  let daemonError: string | null = null;
  try {
    daemon = await getSleepStatus(server.node, server.id);
  } catch (err: any) {
    daemonError = err.message;
  }

  return NextResponse.json({
    config: {
      sleepEnabled: server.sleepEnabled,
      sleepAfterMinutes: server.sleepAfterMinutes,
      autoRestartEnabled: server.autoRestartEnabled,
    },
    status: server.status,
    sleepEmptySince: server.sleepEmptySince,
    lastSleptAt: server.lastSleptAt,
    lastWokeAt: server.lastWokeAt,
    crashCount: server.crashCount,
    crashWindowStartedAt: server.crashWindowStartedAt,
    daemon,
    daemonError,
  });
}

/** Put the server to sleep right now, regardless of how long it has been empty. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await loadServer(params.id);
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  if (server.status === 'SLEEPING') {
    return NextResponse.json({ success: true, message: 'Server is already sleeping' });
  }

  try {
    await requestSleep(server.node, server);
    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'SLEEPING', sleepEmptySince: null, lastSleptAt: new Date() },
    });
    return NextResponse.json({ success: true, message: 'Server is asleep and holding its port' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to sleep server', details: err.message }, { status: 502 });
  }
}

/** Update the sleep policy. */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { sleepEnabled, sleepAfterMinutes, autoRestartEnabled } = body || {};

  if (sleepAfterMinutes !== undefined) {
    const minutes = Number(sleepAfterMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return NextResponse.json(
        { error: 'sleepAfterMinutes must be a whole number between 1 and 1440' },
        { status: 400 }
      );
    }
  }

  const server = await prisma.server.update({
    where: { id: params.id },
    data: {
      ...(sleepEnabled !== undefined ? { sleepEnabled: Boolean(sleepEnabled) } : {}),
      ...(sleepAfterMinutes !== undefined ? { sleepAfterMinutes: Number(sleepAfterMinutes) } : {}),
      ...(autoRestartEnabled !== undefined
        ? { autoRestartEnabled: Boolean(autoRestartEnabled), crashCount: 0, crashWindowStartedAt: null }
        : {}),
      // Turning the feature on or changing the threshold restarts the idle clock
      sleepEmptySince: null,
    },
  });

  return NextResponse.json({
    success: true,
    config: {
      sleepEnabled: server.sleepEnabled,
      sleepAfterMinutes: server.sleepAfterMinutes,
      autoRestartEnabled: server.autoRestartEnabled,
    },
  });
}

/** Stop holding the port and leave the server plainly offline. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await loadServer(params.id);
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  try {
    await cancelSleep(server.node, server.id);
    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'OFFLINE', sleepEmptySince: null },
    });
    return NextResponse.json({ success: true, message: 'Sleep cancelled; server is offline' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to cancel sleep', details: err.message }, { status: 502 });
  }
}
