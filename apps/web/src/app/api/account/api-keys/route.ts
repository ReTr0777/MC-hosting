import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest, API_KEY_PREFIX } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keys = await prisma.apiKey.findMany({
    where: { userId: user.userId },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name, expiresInDays } = await req.json();
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'A name for the key is required' }, { status: 400 });
  }

  const rawKey = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 12);

  const expiresAt = expiresInDays ? new Date(Date.now() + parseInt(expiresInDays, 10) * 24 * 60 * 60 * 1000) : null;

  const apiKey = await prisma.apiKey.create({
    data: { userId: user.userId, name: name.trim(), tokenHash, prefix, expiresAt },
    select: { id: true, name: true, prefix: true, expiresAt: true, createdAt: true },
  });

  return NextResponse.json({
    key: apiKey,
    // Shown exactly once — the hash stored above cannot be reversed back to this.
    rawKey,
  }, { status: 201 });
}
