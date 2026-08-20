import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { Game, parseTerrariaConfig, terrariaSupportsMods } from '@mc-manager/shared';

/**
 * Finishes a chunked `.tmod` upload.
 *
 * The chunks travel through the existing /upload-chunk route, which has been carrying
 * serverpacks across this deployment for a long time and is already sized to stay under
 * Cloudflare's 100 MB body limit. Only the last step is specific to mods: the daemon
 * assembles the pieces, checks the result really is a `.tmod`, and installs it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true, permissions: { where: { userId: user.userId } } },
    });
    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
    const role = server.permissions[0]?.role;
    if (!isGlobalAdmin && (!role || role === 'VIEWER')) {
      return NextResponse.json(
        { error: 'Forbidden: OPERATOR or ADMIN role required to change mods' },
        { status: 403 }
      );
    }

    if (server.game !== Game.TERRARIA || !terrariaSupportsMods(parseTerrariaConfig(server.gameConfig).variant)) {
      return NextResponse.json({ error: 'This server does not run tModLoader.' }, { status: 409 });
    }

    const { uploadId, fileName, totalChunks } = await req.json();

    const daemon = new DaemonClient({
      host: server.node.host,
      port: server.node.port,
      apiKey: server.node.apiKey,
    });
    const target = server.containerId || `process-${server.id}`;

    const data = await daemon.request(`/servers/${target}/tmods/complete`, {
      method: 'POST',
      body: JSON.stringify({ uploadId, fileName, totalChunks }),
    });
    return NextResponse.json(data);
  } catch (err: any) {
    // 4xx rather than 5xx so the message survives: Cloudflare replaces an origin 5xx with
    // its own error page. See ../route.ts.
    const message = err.message || 'Failed to finish the upload';
    const unreachable = /cannot connect to daemon|connection timed out|fetch failed/i.test(message);
    return NextResponse.json({ error: message }, { status: unreachable ? 502 : 400 });
  }
}
