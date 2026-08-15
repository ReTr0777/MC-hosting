import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { getPublicOrigin } from '@/lib/utils/public-url';

/**
 * Exports a node's settings as a file the desktop node app can import.
 *
 * The point is the bearer token: it is the one value an operator would otherwise
 * have to read off one screen and retype into another, and getting it subtly wrong
 * produces a node that looks configured and silently fails to authenticate.
 *
 * The file is a plaintext secret. It is admin-only and audited on the way out, and
 * the panel warns about handing it around — encrypting it would only move the
 * problem to distributing a passphrase.
 */

// Not exported: a Next.js route module may only export its handlers and a fixed set
// of config names, and anything else fails the build.
const NODE_CONFIG_FORMAT = 'mc-hosting-node-config';
const NODE_CONFIG_VERSION = 1;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  const node = await prisma.node.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, port: true, apiKey: true, enabledGames: true },
  });

  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const config = {
    format: NODE_CONFIG_FORMAT,
    version: NODE_CONFIG_VERSION,
    issuedAt: new Date().toISOString(),
    panel: {
      url: await getPublicOrigin(req),
      nodeId: node.id,
      nodeName: node.name,
    },
    node: {
      apiKey: node.apiKey,
      port: node.port,
      enabledGames: node.enabledGames,
    },
  };

  await writeAudit({
    userId: user.userId,
    action: 'NODE_CONFIG_EXPORT',
    details: { nodeId: node.id, name: node.name },
  });

  // Slugged so a browser save gives a recognisable filename per node.
  const slug = node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';

  return new NextResponse(JSON.stringify(config, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${slug}-node-config.json"`,
      // Never let a secret sit in a shared cache.
      'Cache-Control': 'no-store',
    },
  });
}
