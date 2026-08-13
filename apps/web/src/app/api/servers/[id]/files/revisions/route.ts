import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { writeAudit } from '@/lib/audit';

/**
 * Version history for a single config file.
 *
 * GET without `revisionId` lists revisions; with one, returns that version's contents so the editor
 * can diff it. POST restores a revision.
 */

interface ServerContext {
  server: { id: string; name: string; node: { host: string; port: number; apiKey: string } };
  userId: string;
  /** True for roles allowed to change files — VIEWER can look at history but not restore. */
  canWrite: boolean;
}

async function resolve(req: NextRequest, id: string): Promise<ServerContext | NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id },
    include: { node: true, permissions: { where: { userId: user.userId } } },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const role = server.permissions[0]?.role;
  if (!isGlobalAdmin && !role) {
    return NextResponse.json({ error: 'Forbidden: No permission for this server' }, { status: 403 });
  }

  return {
    server,
    userId: user.userId,
    canWrite: isGlobalAdmin || (!!role && role !== 'VIEWER'),
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolve(req, params.id);
  if (ctx instanceof NextResponse) return ctx;

  const relPath = req.nextUrl.searchParams.get('path');
  const revisionId = req.nextUrl.searchParams.get('revisionId');
  if (!relPath) return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });

  const query = new URLSearchParams({ path: relPath });
  if (revisionId) query.set('revisionId', revisionId);

  try {
    const daemon = new DaemonClient(ctx.server.node);
    const data = await daemon.request(`/servers/${ctx.server.id}/files/revisions?${query.toString()}`, {}, 15000);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to read file history' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolve(req, params.id);
  if (ctx instanceof NextResponse) return ctx;

  if (!ctx.canWrite) {
    return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required to restore files' }, { status: 403 });
  }

  const { path: relPath, revisionId } = (await req.json().catch(() => ({}))) as {
    path?: string;
    revisionId?: string;
  };
  if (!relPath || !revisionId) {
    return NextResponse.json({ error: 'Missing path or revisionId' }, { status: 400 });
  }

  try {
    const daemon = new DaemonClient(ctx.server.node);
    const data = await daemon.request(
      `/servers/${ctx.server.id}/files/restore`,
      { method: 'POST', body: JSON.stringify({ path: relPath, revisionId }) },
      15000
    );

    await writeAudit({
      userId: ctx.userId,
      action: 'FILE_RESTORE',
      details: { serverId: ctx.server.id, serverName: ctx.server.name, path: relPath, revisionId },
    });

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to restore revision' }, { status: 500 });
  }
}
