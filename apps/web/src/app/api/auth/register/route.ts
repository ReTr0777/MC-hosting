import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword, signJwtToken, COOKIE_NAME } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { email, username, password, inviteCode } = await req.json();

    if (!email || !username || !password) {
      return NextResponse.json({ error: 'Email, username, and password are required' }, { status: 400 });
    }

    const userCount = await prisma.user.count();
    const globalRole = userCount === 0 ? 'GLOBAL_ADMIN' : 'USER';

    if (userCount > 0) {
      if (!inviteCode) {
        return NextResponse.json({ error: 'An invite code is required to register' }, { status: 403 });
      }

      const invite = await prisma.inviteCode.findUnique({
        where: { code: inviteCode }
      });

      if (!invite) {
        return NextResponse.json({ error: 'Invalid invite code' }, { status: 403 });
      }

      if (invite.maxUses && invite.uses >= invite.maxUses) {
        return NextResponse.json({ error: 'This invite code has reached its maximum uses' }, { status: 403 });
      }

      // We will increment the uses after successfully creating the user
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      return NextResponse.json({ error: 'User with this email or username already exists' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        globalRole,
      },
    });

    if (userCount > 0 && inviteCode) {
      await prisma.inviteCode.update({
        where: { code: inviteCode },
        data: { uses: { increment: 1 } }
      });
    }

    const token = await signJwtToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      globalRole: user.globalRole as 'GLOBAL_ADMIN' | 'USER',
    });

    const response = NextResponse.json({
      message: 'Registration successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        globalRole: user.globalRole,
      },
    });

    response.cookies.set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return response;
  } catch (err: any) {
    console.error('[auth/register] Registration error:', err);
    return NextResponse.json(
      {
        error: 'Failed to register user',
        details: err.message,
        ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
      },
      { status: 500 }
    );
  }
}
