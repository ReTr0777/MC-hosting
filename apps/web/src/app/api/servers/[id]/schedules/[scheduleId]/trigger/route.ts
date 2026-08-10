import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { runSchedule } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

/** Runs a schedule immediately, using the same code path the timer uses. */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const schedule = await prisma.serverSchedule.findUnique({
      where: { id: params.scheduleId },
      include: { server: { include: { node: true } } },
    });

    if (!schedule || schedule.serverId !== params.id) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const result = await runSchedule(schedule as any, { notify: false });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Schedule '${schedule.name}' failed`, details: result.message },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to trigger schedule', details: err.message }, { status: 500 });
  }
}
