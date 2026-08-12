import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { hashToken } from '@/lib/tokens';

export async function POST(req: NextRequest) {
  try {
    const { token, password } = await req.json();
    if (!token || typeof token !== 'string' || !password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Token and new password are required' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const tokenHash = hashToken(token);
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This reset link is invalid or has expired' }, { status: 400 });
    }

    const passwordHash = await hashPassword(password);

    await prisma.$transaction([
      prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
      // Invalidate any other outstanding reset tokens for this user.
      prisma.passwordResetToken.updateMany({
        where: { userId: resetToken.userId, usedAt: null, id: { not: resetToken.id } },
        data: { usedAt: new Date() },
      }),
    ]);

    return NextResponse.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to reset password', details: err.message }, { status: 500 });
  }
}
