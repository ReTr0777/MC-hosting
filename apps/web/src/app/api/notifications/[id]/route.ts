import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/services/notifications';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const { name, enabled, events, url } = await request.json();
    const data: Record<string, unknown> = {};

    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof enabled === 'boolean') data.enabled = enabled;
    if (Array.isArray(events)) {
      data.events = events.filter((e: string) => (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(e));
    }
    if (typeof url === 'string' && url.trim()) {
      if (!/^https:\/\//i.test(url.trim())) {
        return NextResponse.json({ error: 'Webhook URL must start with https://' }, { status: 400 });
      }
      data.url = url.trim();
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    await prisma.notificationChannel.update({ where: { id: params.id }, data });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update channel' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    await prisma.notificationChannel.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete channel' }, { status: 500 });
  }
}
