import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { decryptSecret } from '@/lib/auth/crypto';
import { verifyTotpCode, generateBackupCodes } from '@/lib/auth/totp';

export async function POST(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { code } = await req.json();
  if (!code) {
    return NextResponse.json({ error: 'Missing verification code' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } });
  if (!user || !user.totpSecret) {
    return NextResponse.json({ error: 'Start two-factor setup first' }, { status: 400 });
  }
  if (user.totpEnabled) {
    return NextResponse.json({ error: 'Two-factor authentication is already enabled' }, { status: 400 });
  }

  const secret = decryptSecret(user.totpSecret);
  if (!secret || !verifyTotpCode(secret, String(code).trim())) {
    return NextResponse.json({ error: 'Invalid code — check your authenticator app and try again' }, { status: 400 });
  }

  const { codes, hashes } = await generateBackupCodes();

  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: true, totpBackupCodes: hashes },
  });

  // Backup codes are shown exactly once — the DB only ever holds their hashes.
  return NextResponse.json({ message: 'Two-factor authentication enabled.', backupCodes: codes });
}
