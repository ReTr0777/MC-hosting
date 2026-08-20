import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { Game, parseTerrariaConfig, terrariaSupportsMods } from '@mc-manager/shared';

/**
 * `.tmod` mods for a tModLoader server.
 *
 * Separate from the Minecraft mod routes beside it and sharing nothing with them: those
 * resolve a Modrinth project to a version to a download, and none of that exists here.
 * A tModLoader mod is a file the operator supplies.
 */

/**
 * Resolves the server and checks the caller may change its mods.
 *
 * The variant check is not a formality. Vanilla Terraria ignores a Mods folder entirely,
 * so an upload to a vanilla server would succeed, appear in the list, and never load —
 * failing here says why instead.
 */
async function resolve(req: NextRequest, id: string, needWrite: boolean) {
  try {
    return await resolveOrThrow(req, id, needWrite);
  } catch (err: any) {
    /*
     * Anything unexpected here — the database refusing a connection, a malformed record —
     * would otherwise escape the handler and be served as Next's HTML error page. The
     * caller is a fetch expecting JSON, so it reports "Unexpected token '<'" and the real
     * cause never reaches anyone.
     */
    return {
      error: NextResponse.json(
        { error: `Could not load this server: ${err?.message ?? 'unknown error'}` },
        { status: 500 }
      ),
    };
  }
}

async function resolveOrThrow(req: NextRequest, id: string, needWrite: boolean) {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const server = await prisma.server.findUnique({
    where: { id },
    include: { node: true, permissions: { where: { userId: user.userId } } },
  });
  if (!server) return { error: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const role = server.permissions[0]?.role;
  if (!isGlobalAdmin && !role) {
    return { error: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  if (needWrite && !isGlobalAdmin && (!role || role === 'VIEWER')) {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: OPERATOR or ADMIN role required to change mods' },
        { status: 403 }
      ),
    };
  }

  if (server.game !== Game.TERRARIA) {
    return {
      error: NextResponse.json(
        { error: 'This is not a Terraria server. Minecraft mods are managed separately.' },
        { status: 400 }
      ),
    };
  }

  const config = parseTerrariaConfig(server.gameConfig);
  if (!terrariaSupportsMods(config.variant)) {
    return {
      error: NextResponse.json(
        {
          error:
            `'${server.name}' runs vanilla Terraria, which has no mod system. ` +
            'Switch it to tModLoader first — vanilla ignores mods entirely rather than refusing them.',
        },
        { status: 409 }
      ),
    };
  }

  const daemon = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });

  return { server, daemon, target: server.containerId || `process-${server.id}` };
}

/**
 * The status to answer with when a call to the daemon fails.
 *
 * Not always 502, even though "the upstream call failed" is what 502 means. Cloudflare
 * replaces an origin 5xx with its own branded error page, so a 502 carrying "No such
 * server on this node" reached the browser as several kilobytes of HTML saying nothing —
 * the daemon's diagnosis was thrown away by infrastructure the panel does not control.
 *
 * So a daemon that answered, and simply answered "no", is reported as a 4xx and keeps its
 * message. 502 is reserved for a daemon that could not be reached at all, where there is
 * no message worth preserving anyway.
 */
function daemonFailureStatus(message: string): number {
  const unreachable = /cannot connect to daemon|connection timed out|fetch failed/i.test(message);
  return unreachable ? 502 : 400;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolve(req, params.id, false);
  if ('error' in ctx) return ctx.error;

  try {
    return NextResponse.json(await ctx.daemon.request(`/servers/${ctx.target}/tmods`));
  } catch (err: any) {
    const message = err.message || 'Failed to list mods';
    return NextResponse.json({ error: message }, { status: daemonFailureStatus(message) });
  }
}

/**
 * Uploads one `.tmod`, streamed straight through to the node.
 *
 * The body is the file itself rather than multipart form data: the panel is a proxy here,
 * and buffering a mod into memory on the way past would put it in the panel's heap for no
 * gain. The filename travels as a query parameter for the same reason.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolve(req, params.id, true);
  if ('error' in ctx) return ctx.error;

  const fileName = req.nextUrl.searchParams.get('fileName');
  if (!fileName || !fileName.toLowerCase().endsWith('.tmod')) {
    return NextResponse.json(
      { error: 'fileName is required and must end in .tmod' },
      { status: 400 }
    );
  }

  try {
    const body = Buffer.from(await req.arrayBuffer());
    if (body.length === 0) {
      return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 });
    }

    const data = await ctx.daemon.request(
      `/servers/${ctx.target}/tmods?fileName=${encodeURIComponent(fileName)}`,
      {
        method: 'POST',
        body: body as any,
        headers: { 'Content-Type': 'application/octet-stream' },
      }
    );
    return NextResponse.json(data);
  } catch (err: any) {
    const message = err.message || 'Failed to upload the mod';
    return NextResponse.json({ error: message }, { status: daemonFailureStatus(message) });
  }
}
