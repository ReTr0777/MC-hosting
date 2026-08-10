import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

const CODE_TTL_MS = 10 * 60_000;

/** Generates a one-time code the user pastes into `/link <code>` in Discord. */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const code = crypto.randomBytes(4).toString('hex').toUpperCase();

  await prisma.discordLinkCode.deleteMany({ where: { userId: user.userId } });
  await prisma.discordLinkCode.create({
    data: { code, userId: user.userId, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });

  return NextResponse.json({ code, expiresInSeconds: CODE_TTL_MS / 1000 });
}
