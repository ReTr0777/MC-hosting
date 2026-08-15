import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { YAML_CONFIGS } from '@/lib/integrations/configs';
import { getYamlValue, setYamlValues } from '@/lib/utils/yaml-patch';

async function getDaemonClient(serverId: string) {
  const server = await prisma.server.findUnique({ where: { id: serverId }, include: { node: true } });
  if (!server) return null;
  const daemonClient = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
  // Matches files/read, files/write and mods/list — the daemon's on-disk server
  // directory is keyed by the plain DB id, not the container id.
  return { daemonClient, targetContainerId: server.id };
}

/** Reads the first candidate path that exists, returning its content and which path matched. */
async function readFirstExisting(daemonClient: DaemonClient, serverId: string, candidatePaths: string[]) {
  for (const path of candidatePaths) {
    try {
      const file = await daemonClient.readFile(serverId, path);
      return { path, content: file.content };
    } catch (err: any) {
      continue;
    }
  }
  return null;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const mod = request.nextUrl.searchParams.get('mod') || '';
  const def = YAML_CONFIGS[mod];
  if (!def) return NextResponse.json({ error: `Unknown integration '${mod}'` }, { status: 400 });

  try {
    const ctx = await getDaemonClient(params.id);
    if (!ctx) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const found = await readFirstExisting(ctx.daemonClient, ctx.targetContainerId, def.candidatePaths);

    const settings: Record<string, string> = {};
    for (const field of def.fields) {
      settings[field.dotPath] = (found ? getYamlValue(found.content, field.dotPath) : undefined) ?? field.default;
    }

    return NextResponse.json({
      exists: !!found,
      path: found?.path || def.candidatePaths[0],
      fields: def.fields,
      settings,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch configuration' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const mod = body.mod || '';
  const def = YAML_CONFIGS[mod];
  if (!def) return NextResponse.json({ error: `Unknown integration '${mod}'` }, { status: 400 });

  const { settings } = body;
  if (!settings || typeof settings !== 'object') {
    return NextResponse.json({ error: 'Missing settings object' }, { status: 400 });
  }

  try {
    const ctx = await getDaemonClient(params.id);
    if (!ctx) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const found = await readFirstExisting(ctx.daemonClient, ctx.targetContainerId, def.candidatePaths);
    const baseText = found?.content ?? def.defaultTemplate;
    const targetPath = found?.path ?? def.candidatePaths[0];

    const merged = setYamlValues(baseText, settings);
    await ctx.daemonClient.writeFile(ctx.targetContainerId, targetPath, merged);

    return NextResponse.json({ success: true, message: 'Configuration saved — changes take effect on the next server restart.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save configuration' }, { status: 500 });
  }
}
