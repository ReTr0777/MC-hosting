import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyBotSecret } from '@/lib/auth/discord-bot-auth';
import { runServerAction, LifecycleAction } from '@/lib/servers/actions';

const ACTIONS: LifecycleAction[] = ['start', 'stop', 'restart'];

export async function POST(req: NextRequest) {
  if (!verifyBotSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { discordUserId, serverId, serverName, action } = await req.json().catch(() => ({}));
  if (!discordUserId || (!serverId && !serverName) || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: 'Missing or invalid discordUserId, serverId/serverName, or action' },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { discordUserId: String(discordUserId) } });
  if (!user) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 });

  /*
   * By id when the bot has one — autocomplete and buttons both do. Names are accepted
   * because someone typing the command by hand still can, but they are ambiguous:
   * nothing stops two servers being called "survival", and findFirst would silently pick
   * whichever sorted first and act on a server the user did not mean.
   */
  const server = serverId
    ? await prisma.server.findUnique({
        where: { id: String(serverId) },
        include: { node: true, permissions: { where: { userId: user.id } } },
      })
    : await prisma.server.findFirst({
        where: { name: { equals: String(serverName), mode: 'insensitive' } },
        include: { node: true, permissions: { where: { userId: user.id } } },
      });

  if (!server) {
    return NextResponse.json(
      { error: serverId ? 'That server no longer exists.' : `No server named "${serverName}"` },
      { status: 404 }
    );
  }

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const role = server.permissions[0]?.role;
  if (!isGlobalAdmin && (!role || role === 'VIEWER')) {
    return NextResponse.json({ error: 'You do not have permission to manage this server' }, { status: 403 });
  }

  try {
    const result = await runServerAction(server, action as LifecycleAction);
    return NextResponse.json({ ...result, serverId: server.id, serverName: server.name });
  } catch (err: any) {
    /*
     * A suspension is a decision, not a fault, and it arrives here as a thrown message
     * meant for the person reading it. Reporting it as a 500 "Failed to start" would bury
     * the one sentence that explains why.
     */
    const message = String(err?.message ?? '');
    const isPolicy = /suspend/i.test(message);
    return NextResponse.json(
      { error: isPolicy ? message : `Failed to ${action} server`, details: isPolicy ? undefined : message },
      { status: isPolicy ? 403 : 500 }
    );
  }
}
