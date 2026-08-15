import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { encryptSecret } from '@/lib/auth/crypto';
import { generateTotpSecret, totpKeyUri } from '@/lib/auth/totp';

export async function POST(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  if (user.totpEnabled) {
    return NextResponse.json({ error: 'Two-factor authentication is already enabled. Disable it first to re-enroll.' }, { status: 400 });
  }

  // Stored immediately but totpEnabled stays false until /enable proves the app scanned it correctly —
  // otherwise a typo'd QR scan could brick the account's login.
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret) } });

  const uri = totpKeyUri(secret, user.email);
  const qrCodeDataUrl = await QRCode.toDataURL(uri);

  return NextResponse.json({ secret, qrCodeDataUrl });
}
