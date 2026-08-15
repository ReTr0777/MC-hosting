import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';

export interface QuarantinedMod {
  fileName: string;
  reason: 'denylist' | 'declared-client' | 'modrinth-client' | 'filename-hint' | 'missing-dependency';
  detail: string;
  missingDependency?: string;
}

export interface PackHealth {
  generatedAt: string | null;
  scanned: number;
  quarantined: QuarantinedMod[];
  unresolved: Array<{ id: string; hard: boolean; requiredBy: string[] }>;
  unidentified: string[];
}

async function resolveServer(req: NextRequest, id: string) {
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
    return { error: NextResponse.json({ error: 'Forbidden: No permission for this server' }, { status: 403 }) };
  }

  return { user, server, role, isGlobalAdmin };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolveServer(req, params.id);
  if (ctx.error) return ctx.error;
  const { server } = ctx;

  try {
    const daemon = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
    // Reading every jar's metadata on a 300-mod pack takes longer than the client's default budget.
    const data = await daemon.request<PackHealth>(`/servers/${server.id}/pack-health`, {}, 30000);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /pack-health GET error]', err.message);
    return NextResponse.json({ error: err.message || 'Failed to read pack health' }, { status: 500 });
  }
}

/**
 * Enable or disable a single mod. Restoring a quarantined jar is the escape hatch for a scan that
 * got it wrong, so it needs write access rather than the read access GET is happy with.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolveServer(req, params.id);
  if (ctx.error) return ctx.error;
  const { server, user, role, isGlobalAdmin } = ctx;

  if (!isGlobalAdmin && role !== 'OWNER' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden: mod changes require admin access' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { fileName, enable } = body || {};
  if (typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
  }

  try {
    const daemon = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
    const data = await daemon.request<{ success: boolean }>(
      `/servers/${server.id}/pack-health/toggle`,
      { method: 'POST', body: JSON.stringify({ fileName, enable: !!enable }) },
      15000
    );

    await writeAudit({
      userId: user.userId,
      action: enable ? 'MOD_ENABLE' : 'MOD_DISABLE',
      details: { serverId: server.id, serverName: server.name, fileName },
    });

    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[API /pack-health POST error]', err.message);
    return NextResponse.json({ error: err.message || 'Failed to toggle mod' }, { status: 500 });
  }
}
