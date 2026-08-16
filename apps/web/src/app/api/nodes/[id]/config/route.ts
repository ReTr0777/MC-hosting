import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { getPublicOrigin } from '@/lib/utils/public-url';
import { tryDecryptSecret } from '@/lib/auth/crypto';
import { buildFrpPreset, FRP_ADDR_KEY, FRP_PORT_KEY, FRP_TOKEN_KEY } from '@/lib/servers/frp';

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

  /*
   * The tunnel preset rides along when the installation has one.
   *
   * Every node tunnels to the same frps with the same token, so those three values are
   * a property of the deployment rather than of any one node — and without them here
   * the operator is left typing an address, a port and a shared secret into every
   * desktop app by hand, which is exactly the transcription the export exists to
   * avoid. Omitted entirely when no address is set, which the node app reads as
   * "leave whatever tunnel settings are already there alone".
   */
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: [FRP_ADDR_KEY, FRP_PORT_KEY, FRP_TOKEN_KEY] } },
  });
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const tunnel = buildFrpPreset(
    byKey[FRP_ADDR_KEY],
    byKey[FRP_PORT_KEY],
    tryDecryptSecret(byKey[FRP_TOKEN_KEY] || '').value
  );

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
    ...(tunnel ? { tunnel } : {}),
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
