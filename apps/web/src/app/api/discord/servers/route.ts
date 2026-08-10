import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyBotSecret } from '@/lib/discord-bot-auth';

/** Lists servers the linked Discord user can see, with current status — backs /status. */
export async function GET(req: NextRequest) {
  if (!verifyBotSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const discordUserId = req.nextUrl.searchParams.get('discordUserId');
  if (!discordUserId) return NextResponse.json({ error: 'Missing discordUserId' }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { discordUserId } });
  if (!user) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const servers = await prisma.server.findMany({
    where: isGlobalAdmin ? {} : { permissions: { some: { userId: user.id } } },
    select: { id: true, name: true, status: true, serverType: true, mcVersion: true },
    orderBy: { name: 'asc' },
  });

  return NextResponse.json({ servers });
}
