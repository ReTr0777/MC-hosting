import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyBotSecret } from '@/lib/auth/discord-bot-auth';
import { runServerAction, LifecycleAction } from '@/lib/servers/actions';

const ACTIONS: LifecycleAction[] = ['start', 'stop', 'restart'];

export async function POST(req: NextRequest) {
  if (!verifyBotSecret(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { discordUserId, serverName, action } = await req.json().catch(() => ({}));
  if (!discordUserId || !serverName || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: 'Missing or invalid discordUserId, serverName, or action' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { discordUserId: String(discordUserId) } });
  if (!user) return NextResponse.json({ error: 'NOT_LINKED' }, { status: 404 });

  const server = await prisma.server.findFirst({
    where: { name: { equals: String(serverName), mode: 'insensitive' } },
    include: { node: true, permissions: { where: { userId: user.id } } },
  });
  if (!server) return NextResponse.json({ error: `No server named "${serverName}"` }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const role = server.permissions[0]?.role;
  if (!isGlobalAdmin && (!role || role === 'VIEWER')) {
    return NextResponse.json({ error: 'You do not have permission to manage this server' }, { status: 403 });
  }

  try {
    const result = await runServerAction(server, action as LifecycleAction);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: `Failed to ${action} server`, details: err.message }, { status: 500 });
  }
}
