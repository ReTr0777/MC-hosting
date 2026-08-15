import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/services/notifications';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const [channels, deliveries] = await Promise.all([
      prisma.notificationChannel.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    // Never hand the full webhook URL back to the browser — it is a bearer credential
    const safeChannels = channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      events: c.events,
      urlPreview: maskUrl(c.url),
      createdAt: c.createdAt,
    }));

    return NextResponse.json({ channels: safeChannels, deliveries, eventTypes: NOTIFICATION_EVENT_TYPES });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to load notification settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const { name, type, url, events } = await request.json();

    if (!name?.trim() || !url?.trim()) {
      return NextResponse.json({ error: 'Name and webhook URL are required' }, { status: 400 });
    }
    if (!/^https:\/\//i.test(url.trim())) {
      return NextResponse.json({ error: 'Webhook URL must start with https://' }, { status: 400 });
    }

    const channelType = type === 'GENERIC' ? 'GENERIC' : 'DISCORD';
    const validEvents = Array.isArray(events)
      ? events.filter((e: string) => (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(e))
      : [];

    const channel = await prisma.notificationChannel.create({
      data: { name: name.trim(), type: channelType, url: url.trim(), events: validEvents },
    });

    return NextResponse.json({ success: true, id: channel.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create channel' }, { status: 500 });
  }
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…${url.slice(-6)}`;
  } catch {
    return '…';
  }
}
