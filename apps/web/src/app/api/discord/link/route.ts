import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyBotSecret } from '@/lib/auth/discord-bot-auth';

export async function POST(req: NextRequest) {
  if (!verifyBotSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { code, discordUserId } = await req.json().catch(() => ({}));
  if (!code || !discordUserId) {
    return NextResponse.json({ error: 'Missing code or discordUserId' }, { status: 400 });
  }

  const link = await prisma.discordLinkCode.findUnique({ where: { code: String(code).toUpperCase() } });
  if (!link || link.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Code is invalid or expired' }, { status: 404 });
  }

  const existing = await prisma.user.findUnique({ where: { discordUserId: String(discordUserId) } });
  if (existing && existing.id !== link.userId) {
    return NextResponse.json({ error: 'This Discord account is already linked to a different panel account' }, { status: 409 });
  }

  const user = await prisma.user.update({
    where: { id: link.userId },
    data: { discordUserId: String(discordUserId) },
  });
  await prisma.discordLinkCode.delete({ where: { id: link.id } });

  return NextResponse.json({ success: true, username: user.username });
}
