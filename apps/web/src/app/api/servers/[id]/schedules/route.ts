import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { cronError, nextRun } from '@/lib/cron';
import { SCHEDULE_ACTIONS } from '@/lib/scheduler';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Schedules are rows in the panel's own database, so these routes talk to Postgres
 * directly. They used to proxy to the daemon, which needed DATABASE_URL it never had —
 * every request failed with a 503 and no schedule ever ran.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const schedules = await prisma.serverSchedule.findMany({
      where: { serverId: params.id },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ schedules });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch schedules', details: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { name, cronExpression, actionType, payload, isEnabled } = body || {};

    if (!name || !cronExpression || !actionType) {
      return NextResponse.json(
        { error: 'Missing required schedule fields (name, cronExpression, actionType)' },
        { status: 400 }
      );
    }

    if (!SCHEDULE_ACTIONS.includes(actionType)) {
      return NextResponse.json(
        { error: `Unknown action "${actionType}"`, details: `Expected one of: ${SCHEDULE_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }

    // Reject a bad expression at creation time rather than letting it quietly never match
    const badCron = cronError(cronExpression);
    if (badCron) {
      return NextResponse.json({ error: 'Invalid cron expression', details: badCron }, { status: 400 });
    }

    if (actionType === 'COMMAND' && !payload) {
      return NextResponse.json({ error: 'A COMMAND schedule needs a command to run' }, { status: 400 });
    }

    const server = await prisma.server.findUnique({ where: { id: params.id } });
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const schedule = await prisma.serverSchedule.create({
      data: {
        serverId: params.id,
        name,
        cronExpression,
        actionType,
        payload: payload || null,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
        nextRunAt: nextRun(cronExpression),
      },
    });

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_CREATE',
      details: { serverId: params.id, scheduleId: schedule.id, name, cronExpression, actionType },
    });

    return NextResponse.json({ success: true, schedule });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to create schedule', details: err.message }, { status: 500 });
  }
}
