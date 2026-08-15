import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest, verifyPassword } from '@/lib/auth';
import { decryptSecret } from '@/lib/auth/crypto';
import { verifyTotpCode, matchBackupCode } from '@/lib/auth/totp';

export async function POST(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { password, code } = await req.json();
  if (!password || !code) {
    return NextResponse.json({ error: 'Current password and a valid code are required' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } });
  if (!user || !user.totpEnabled || !user.totpSecret) {
    return NextResponse.json({ error: 'Two-factor authentication is not enabled' }, { status: 400 });
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const cleanCode = String(code).trim();
  const secret = decryptSecret(user.totpSecret);
  const validTotp = secret && verifyTotpCode(secret, cleanCode);
  const validBackup = !validTotp && (await matchBackupCode(cleanCode, user.totpBackupCodes));

  if (!validTotp && !validBackup) {
    return NextResponse.json({ error: 'Invalid authentication code' }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: false, totpSecret: null, totpBackupCodes: [] },
  });

  return NextResponse.json({ message: 'Two-factor authentication disabled.' });
}
