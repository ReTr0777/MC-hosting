import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { Game, parseTerrariaConfig, terrariaSupportsMods } from '@mc-manager/shared';

/**
 * One installed `.tmod`: enable, disable, or remove.
 *
 * The two verbs key on different things, and deliberately so. PATCH is a change to
 * `enabled.json`, which holds mods' **internal** names; DELETE removes a file, which is
 * identified by its **filename**. Those are regularly not the same string — a mod shipped
 * as `Calamity Mod v2.0.tmod` calls itself `CalamityMod` — so collapsing them to one
 * identifier would make one of the two operations silently target nothing. The mod list
 * returns both values for exactly this reason.
 */

async function resolve(req: NextRequest, id: string) {
  try {
    return await resolveOrThrow(req, id);
  } catch (err: any) {
    // See the note in ../route.ts: an escaping throw becomes an HTML error page, which the
    // caller can only report as a JSON parse failure.
    return {
      error: NextResponse.json(
        { error: `Could not load this server: ${err?.message ?? 'unknown error'}` },
        { status: 500 }
      ),
    };
  }
}

async function resolveOrThrow(req: NextRequest, id: string) {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const server = await prisma.server.findUnique({
    where: { id },
    include: { node: true, permissions: { where: { userId: user.userId } } },
  });
  if (!server) return { error: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const role = server.permissions[0]?.role;
  if (!isGlobalAdmin && (!role || role === 'VIEWER')) {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: OPERATOR or ADMIN role required to change mods' },
        { status: 403 }
      ),
    };
  }

  if (server.game !== Game.TERRARIA || !terrariaSupportsMods(parseTerrariaConfig(server.gameConfig).variant)) {
    return {
      error: NextResponse.json(
        { error: 'This server does not run tModLoader.' },
        { status: 409 }
      ),
    };
  }

  return {
    daemon: new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    }),
    target: server.containerId || `process-${server.id}`,
  };
}

/** See ../route.ts: a 5xx from here is replaced by Cloudflare's own page, message and all. */
function daemonFailureStatus(message: string): number {
  return /cannot connect to daemon|connection timed out|fetch failed/i.test(message) ? 502 : 400;
}

/** Enable or disable a mod, by its internal name. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string; name: string } }) {
  const ctx = await resolve(req, params.id);
  if ('error' in ctx) return ctx.error;

  try {
    const { enabled } = await req.json();
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
    }

    const data = await ctx.daemon.request(
      `/servers/${ctx.target}/tmods/${encodeURIComponent(params.name)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) }
    );
    return NextResponse.json(data);
  } catch (err: any) {
    const message = err.message || 'Failed to change the mod';
    return NextResponse.json({ error: message }, { status: daemonFailureStatus(message) });
  }
}

/** Remove a mod, by its filename. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string; name: string } }) {
  const ctx = await resolve(req, params.id);
  if ('error' in ctx) return ctx.error;

  try {
    const data = await ctx.daemon.request(
      `/servers/${ctx.target}/tmods/${encodeURIComponent(params.name)}`,
      { method: 'DELETE' }
    );
    return NextResponse.json(data);
  } catch (err: any) {
    const message = err.message || 'Failed to remove the mod';
    return NextResponse.json({ error: message }, { status: daemonFailureStatus(message) });
  }
}
