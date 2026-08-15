import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPassword, signJwtToken, signPreAuthToken, COOKIE_NAME } from '@/lib/auth';
import { userSuspensionMessage } from '@/lib/servers/suspension';

export async function POST(req: NextRequest) {
  try {
    const { login, password } = await req.json();

    if (!login || !password) {
      return NextResponse.json({ error: 'Username/Email and password are required' }, { status: 400 });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: login }, { username: login }],
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const isPasswordValid = await verifyPassword(password, user.passwordHash);
    if (!isPasswordValid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Checked after the password so a wrong guess can't be used to discover that an account
    // exists and is suspended.
    const suspended = userSuspensionMessage(user);
    if (suspended) {
      return NextResponse.json({ error: suspended }, { status: 403 });
    }

    if (user.totpEnabled) {
      const preAuthToken = await signPreAuthToken(user.id);
      return NextResponse.json({ requires2FA: true, preAuthToken });
    }

    const token = await signJwtToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      globalRole: user.globalRole as 'GLOBAL_ADMIN' | 'USER',
    });

    const response = NextResponse.json({
      message: 'Login successful',
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
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to authenticate', details: err.message }, { status: 500 });
  }
}
