import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { generateShareToken, hashSharePassword } from '@/lib/map-share';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({ where: { id: params.id } });
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const { label, password, expiresInHours } = await request.json();

    let expiresAt: Date | null = null;
    const hours = Number(expiresInHours);
    if (hours && hours > 0) {
      expiresAt = new Date(Date.now() + hours * 3600 * 1000);
    }

    const share = await prisma.mapShare.create({
      data: {
        token: generateShareToken(),
        serverId: server.id,
        label: typeof label === 'string' && label.trim() ? label.trim() : null,
        passwordHash: typeof password === 'string' && password.trim() ? hashSharePassword(password.trim()) : null,
        expiresAt,
        createdBy: user.email,
      },
    });

    return NextResponse.json({ success: true, token: share.token, id: share.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create share link' }, { status: 500 });
  }
}
