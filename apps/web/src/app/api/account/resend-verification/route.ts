import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { generateToken } from '@/lib/tokens';
import { sendVerificationEmail } from '@/lib/email';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  if (user.emailVerifiedAt) {
    return NextResponse.json({ message: 'Email is already verified.' });
  }

  const { raw, hash } = generateToken();
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });

  const verifyUrl = `${req.nextUrl.origin}/verify-email?token=${raw}`;
  const sent = await sendVerificationEmail(user.email, verifyUrl);

  if (!sent) {
    return NextResponse.json({ error: 'SMTP is not configured — ask a Global Admin to set it up in System Settings.' }, { status: 503 });
  }

  return NextResponse.json({ message: 'Verification email sent.' });
}
