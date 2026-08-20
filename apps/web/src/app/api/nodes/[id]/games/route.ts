import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';
import { ALL_GAMES, parseGameList } from '@mc-manager/shared';

/**
 * Sets which games a node hosts.
 *
 * Written to the daemon first and to the database only once it has accepted. The node's
 * config.json is the source of truth — every health poll copies enabledGames from it
 * back over the stored value — so a database-only write would be undone within seconds
 * and the operator would watch their change revert for no stated reason.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  const node = await prisma.node.findUnique({ where: { id: params.id } });
  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const enabledGames = parseGameList(body?.enabledGames);
  if (!enabledGames) {
    return NextResponse.json(
      { error: `enabledGames must contain at least one of: ${ALL_GAMES.join(', ')}` },
      { status: 400 }
    );
  }

  /*
   * Servers already on the node are not migrated or stopped by this. Disabling a game
   * stops new ones being placed here; the existing ones keep running, which is the only
   * behaviour that does not turn a settings change into an outage. The page warns when
   * the choice would strand something.
   */
  const client = new DaemonClient({ host: node.host, port: node.port, apiKey: node.apiKey });

  try {
    await client.setEnabledGames(enabledGames);
  } catch (err: any) {
    // A daemon predating /system/games answers 404. Nothing was written on either side,
    // so this is "the node is too old", not a partial save.
    const tooOld = /404|not found/i.test(err.message || '');
    return NextResponse.json(
      {
        error: tooOld
          ? `Node '${node.name}' is running a daemon too old to change this from the panel. ` +
            'Update the node, or set it in the daemon\'s own setup GUI.'
          : `Could not reach node '${node.name}': ${err.message}`,
      },
      { status: tooOld ? 501 : 502 }
    );
  }

  const updated = await prisma.node.update({
    where: { id: node.id },
    data: { enabledGames },
    select: { id: true, name: true, enabledGames: true },
  });

  await writeAudit({
    userId: user.userId,
    action: 'NODE_GAMES_UPDATE',
    details: { nodeId: node.id, name: node.name, enabledGames },
  });

  return NextResponse.json({ message: 'Enabled games updated', node: updated });
}
