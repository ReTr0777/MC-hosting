import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyBotSecret } from '@/lib/auth/discord-bot-auth';
import { Game, parseTerrariaConfig } from '@mc-manager/shared';

/**
 * Lists servers the linked Discord user can see — backs /status and the autocomplete on
 * every command that takes a server.
 *
 * The bot renders buttons from this, so each row carries whether *this* user may act on
 * it. Deciding that in the bot from a role string would put an authorisation rule in two
 * places; deciding it here means the button is simply absent when it would be refused,
 * and a stale button still fails closed at /api/discord/action.
 */
export async function GET(req: NextRequest) {
  if (!verifyBotSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const discordUserId = req.nextUrl.searchParams.get('discordUserId');
  if (!discordUserId) return NextResponse.json({ error: 'Missing discordUserId' }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { discordUserId } });
  if (!user) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const rows = await prisma.server.findMany({
    where: isGlobalAdmin ? {} : { permissions: { some: { userId: user.id } } },
    select: {
      id: true,
      name: true,
      status: true,
      game: true,
      gameConfig: true,
      serverType: true,
      mcVersion: true,
      subdomain: true,
      domain: true,
      sleepEnabled: true,
      permissions: { where: { userId: user.id }, select: { role: true } },
    },
    orderBy: { name: 'asc' },
  });

  const servers = rows.map((s) => {
    const role = isGlobalAdmin ? 'OWNER' : s.permissions[0]?.role ?? null;

    /*
     * One label per game rather than serverType/mcVersion for everything. Those two
     * columns are Minecraft-only — a Terraria server carries the defaults FABRIC and
     * 1.20.1 in them, which the bot was printing as though they meant something.
     */
    let label: string;
    if (s.game === Game.TERRARIA) {
      const cfg = parseTerrariaConfig(s.gameConfig);
      label =
        cfg.variant === 'TMODLOADER'
          ? `tModLoader ${cfg.tmodloaderVersion ?? ''}`.trim()
          : `Terraria ${cfg.terrariaVersion ?? ''}`.trim();
    } else {
      label = `${s.serverType} ${s.mcVersion}`;
    }

    return {
      id: s.id,
      name: s.name,
      status: s.status,
      game: s.game,
      label,
      address: s.subdomain && s.domain ? `${s.subdomain}.${s.domain}` : null,
      sleepEnabled: s.sleepEnabled,
      // VIEWER can see a server but not act on it, so the bot shows it without buttons.
      canManage: role !== null && role !== 'VIEWER',
    };
  });

  return NextResponse.json({ servers });
}
