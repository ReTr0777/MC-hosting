import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateToken } from '@/lib/auth/tokens';
import { sendPasswordResetEmail, isEmailConfigured } from '@/lib/services/email';
import { getPublicOrigin } from '@/lib/utils/public-url';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

    // Always respond the same way regardless of whether the account exists, so this
    // endpoint can't be used to enumerate registered emails.
    const genericResponse = NextResponse.json({
      message: 'If an account with that email exists, a password reset link has been sent.',
    });

    if (!user) return genericResponse;

    const { raw, hash } = generateToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const resetUrl = `${await getPublicOrigin(req)}/reset-password?token=${raw}`;
    const sent = await sendPasswordResetEmail(user.email, resetUrl);

    if (!sent) {
      console.warn(`[forgot-password] SMTP not configured. Reset link for ${user.email}: ${resetUrl}`);
    }

    return genericResponse;
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to process request', details: err.message }, { status: 500 });
  }
}
