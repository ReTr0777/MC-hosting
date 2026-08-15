import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPreAuthToken, signJwtToken, COOKIE_NAME } from '@/lib/auth';
import { decryptSecret } from '@/lib/auth/crypto';
import { verifyTotpCode, matchBackupCode } from '@/lib/auth/totp';
import { userSuspensionMessage } from '@/lib/servers/suspension';

export async function POST(req: NextRequest) {
  try {
    const { preAuthToken, code } = await req.json();
    if (!preAuthToken || !code) {
      return NextResponse.json({ error: 'Missing token or code' }, { status: 400 });
    }

    const userId = await verifyPreAuthToken(preAuthToken);
    if (!userId) {
      return NextResponse.json({ error: 'This login attempt has expired. Please sign in again.' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      return NextResponse.json({ error: 'Two-factor authentication is not enabled for this account' }, { status: 400 });
    }

    const cleanCode = String(code).trim().replace(/\s+/g, '');
    const secret = decryptSecret(user.totpSecret);
    let ok = secret && verifyTotpCode(secret, cleanCode);

    if (!ok) {
      const matchedHash = await matchBackupCode(cleanCode, user.totpBackupCodes);
      if (matchedHash) {
        ok = true;
        // Backup codes are single-use — remove the one that was just spent.
        await prisma.user.update({
          where: { id: user.id },
          data: { totpBackupCodes: user.totpBackupCodes.filter((h) => h !== matchedHash) },
        });
      }
    }

    if (!ok) {
      return NextResponse.json({ error: 'Invalid authentication code' }, { status: 401 });
    }

    // A suspension applied between the password step and this one must still stop the session.
    const suspended = userSuspensionMessage(user);
    if (suspended) {
      return NextResponse.json({ error: suspended }, { status: 403 });
    }

    const token = await signJwtToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      globalRole: user.globalRole as 'GLOBAL_ADMIN' | 'USER',
    });

    const response = NextResponse.json({
      message: 'Login successful',
      user: { id: user.id, email: user.email, username: user.username, globalRole: user.globalRole },
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
    return NextResponse.json({ error: 'Failed to verify code', details: err.message }, { status: 500 });
  }
}
