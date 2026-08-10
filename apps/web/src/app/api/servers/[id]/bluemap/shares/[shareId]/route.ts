import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { hashSharePassword } from '@/lib/map-share';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; shareId: string } }
) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { enabled, label, password, clearPassword, expiresInHours } = await request.json();
    const data: Record<string, unknown> = {};

    if (typeof enabled === 'boolean') data.enabled = enabled;
    if (typeof label === 'string') data.label = label.trim() || null;

    if (clearPassword === true) {
      data.passwordHash = null;
    } else if (typeof password === 'string' && password.trim()) {
      data.passwordHash = hashSharePassword(password.trim());
    }

    if (expiresInHours !== undefined) {
      const hours = Number(expiresInHours);
      data.expiresAt = hours && hours > 0 ? new Date(Date.now() + hours * 3600 * 1000) : null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    await prisma.mapShare.update({
      where: { id: params.shareId, serverId: params.id },
      data,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update share link' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; shareId: string } }
) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await prisma.mapShare.delete({ where: { id: params.shareId, serverId: params.id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete share link' }, { status: 500 });
  }
}
