import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { sendTestNotification } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

/**
 * Sends a test alert. Accepts either an existing channel id (so a saved webhook can be
 * re-tested without re-entering its URL) or a raw url+type for pre-save validation.
 */
export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const { channelId, url, type } = await request.json();

    let targetUrl = typeof url === 'string' ? url.trim() : '';
    let targetType = type === 'GENERIC' ? 'GENERIC' : 'DISCORD';

    if (channelId) {
      const channel = await prisma.notificationChannel.findUnique({ where: { id: channelId } });
      if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
      targetUrl = channel.url;
      targetType = channel.type;
    }

    if (!targetUrl) {
      return NextResponse.json({ error: 'A webhook URL is required' }, { status: 400 });
    }
    if (!/^https:\/\//i.test(targetUrl)) {
      return NextResponse.json({ error: 'Webhook URL must start with https://' }, { status: 400 });
    }

    await sendTestNotification(targetType, targetUrl);
    return NextResponse.json({ success: true, message: '🟢 Test alert delivered — check your channel.' });
  } catch (err: any) {
    const detail = err?.name === 'AbortError' ? 'Timed out after 8s' : err?.message || 'Unknown error';
    return NextResponse.json({ success: false, error: `Delivery failed: ${detail}` }, { status: 502 });
  }
}
