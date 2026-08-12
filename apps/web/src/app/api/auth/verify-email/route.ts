import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashToken } from '@/lib/tokens';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const tokenHash = hashToken(token);
  const verifyToken = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });

  if (!verifyToken || verifyToken.usedAt || verifyToken.expiresAt < new Date()) {
    return NextResponse.json({ error: 'This verification link is invalid or has expired' }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: verifyToken.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.emailVerificationToken.update({ where: { id: verifyToken.id }, data: { usedAt: new Date() } }),
  ]);

  return NextResponse.json({ message: 'Email verified successfully.' });
}
