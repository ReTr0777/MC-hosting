import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { cronError, nextRun } from '@/lib/cron';
import { SCHEDULE_ACTIONS } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { name, cronExpression, actionType, payload, isEnabled } = body || {};

    if (cronExpression) {
      const badCron = cronError(cronExpression);
      if (badCron) {
        return NextResponse.json({ error: 'Invalid cron expression', details: badCron }, { status: 400 });
      }
    }

    if (actionType && !SCHEDULE_ACTIONS.includes(actionType)) {
      return NextResponse.json(
        { error: `Unknown action "${actionType}"`, details: `Expected one of: ${SCHEDULE_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }

    const existing = await prisma.serverSchedule.findUnique({ where: { id: params.scheduleId } });
    if (!existing || existing.serverId !== params.id) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const schedule = await prisma.serverSchedule.update({
      where: { id: params.scheduleId },
      data: {
        ...(name && { name }),
        ...(cronExpression && { cronExpression, nextRunAt: nextRun(cronExpression) }),
        ...(actionType && { actionType }),
        ...(payload !== undefined && { payload }),
        ...(isEnabled !== undefined ? { isEnabled: Boolean(isEnabled) } : {}),
      },
    });

    return NextResponse.json({ success: true, schedule });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to update schedule', details: err.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const existing = await prisma.serverSchedule.findUnique({ where: { id: params.scheduleId } });
    if (!existing || existing.serverId !== params.id) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    await prisma.serverSchedule.delete({ where: { id: params.scheduleId } });
    return NextResponse.json({ success: true, message: 'Schedule deleted' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to delete schedule', details: err.message }, { status: 500 });
  }
}
