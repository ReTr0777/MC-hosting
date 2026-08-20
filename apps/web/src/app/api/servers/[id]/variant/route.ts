import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';
import {
  Game, parseTerrariaConfig, TERRARIA_VARIANTS, TerrariaVariant, terrariaSupportsMods,
} from '@mc-manager/shared';

/**
 * Switches a Terraria server between vanilla and tModLoader.
 *
 * This is a different server *binary*, not a setting, and the change is not symmetric.
 * Vanilla → tModLoader is safe: tModLoader reads vanilla worlds, which is the normal way
 * people start a modded server. The other direction is safe only until mods have actually
 * run — once a mod has placed its own tiles and items in the world, vanilla Terraria
 * cannot load them, and what it does instead is drop them, silently and permanently.
 *
 * So the route takes a backup before it changes anything. Not a suggestion in the UI: the
 * one moment the backup is worth having is the moment before this, and asking someone to
 * remember it there is asking them to remember it exactly when they are focused on
 * something else.
 */

/** Only these two are implemented; TSHOCK is reserved in the type and has no runtime. */
const SWITCHABLE: TerrariaVariant[] = ['VANILLA', 'TMODLOADER'];

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true, permissions: { where: { userId: user.userId } } },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  // Same standing as a restore: this rewrites what the world will be loaded by.
  const role = user.globalRole === 'GLOBAL_ADMIN' ? 'OWNER' : server.permissions[0]?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Forbidden: only a server admin or its owner can change the Terraria variant' },
      { status: 403 }
    );
  }

  if (server.game !== Game.TERRARIA) {
    return NextResponse.json({ error: 'Only Terraria servers have a variant.' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const variant = body?.variant;
  if (!TERRARIA_VARIANTS.includes(variant) || !SWITCHABLE.includes(variant)) {
    return NextResponse.json(
      { error: `variant must be one of: ${SWITCHABLE.join(', ')}` },
      { status: 400 }
    );
  }

  const current = parseTerrariaConfig(server.gameConfig);
  if (current.variant === variant) {
    return NextResponse.json({ message: 'Already running that variant.', variant });
  }

  /*
   * Stopped, not "stopping" or "sleeping".
   *
   * Swapping the binary under a running server means the next start uses a different
   * executable against a world the old one still has open — and a SLEEPING server will be
   * started by the next player who tries to join, with no operator watching.
   */
  if (server.status !== 'OFFLINE' && server.status !== 'ERROR') {
    return NextResponse.json(
      {
        error:
          `'${server.name}' is ${server.status.toLowerCase()}. Stop it before changing the variant — ` +
          'a sleeping server counts as running, because the next player to connect will start it.',
      },
      { status: 409 }
    );
  }

  const daemon = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });
  const target = server.containerId || `process-${server.id}`;

  /*
   * Backup first, and fail the whole thing if it fails.
   *
   * Going to vanilla is the direction that can destroy modded content, but the backup is
   * taken in both directions: a first tModLoader boot rewrites the world with mod data in
   * it, and if a mod turns out to be broken the pre-conversion copy is the only way back.
   */
  let backupName: string | null = null;
  try {
    const result = await daemon.request<{ success: boolean; backup?: { name?: string } }>(
      `/servers/${target}/backups`,
      { method: 'POST', body: JSON.stringify({ name: `pre-${variant.toLowerCase()}` }) }
    );
    backupName = result?.backup?.name ?? `pre-${variant.toLowerCase()}`;
  } catch (err: any) {
    return NextResponse.json(
      {
        error:
          `Could not back up '${server.name}' before converting, so nothing was changed: ${err.message}. ` +
          'Fix the backup problem first — converting without one risks the world.',
      },
      { status: 502 }
    );
  }

  const updated = await prisma.server.update({
    where: { id: server.id },
    data: { gameConfig: { ...current, variant } as any },
    select: { id: true, name: true, gameConfig: true },
  });

  await writeAudit({
    userId: user.userId,
    action: 'SERVER_VARIANT_CHANGE',
    details: { serverId: server.id, name: server.name, from: current.variant, to: variant, backupName },
  });

  return NextResponse.json({
    message: `${server.name} will now run ${variant === 'TMODLOADER' ? 'tModLoader' : 'vanilla Terraria'}.`,
    variant,
    backupName,
    modsEnabled: terrariaSupportsMods(variant),
    // The download happens on the next start, not now, and the first one is slow: the
    // node fetches ~60 MB of tModLoader plus a .NET runtime before the server boots.
    firstStartSlow: variant === 'TMODLOADER',
  });
}
