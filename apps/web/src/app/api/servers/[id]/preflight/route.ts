import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';

/**
 * Why a server will not work, and what to press about it.
 *
 * The findings come from the node, because they are conclusions about files. The fixes are
 * applied here, because they are changes to what the panel believes — a loader written into
 * the database, a world set aside on the node.
 *
 * The whole point is that none of these problems announce themselves at runtime. A Forge
 * pack started as Fabric loads no mods, generates a plain world, and reports success.
 */

export interface PreflightFix {
  action: 'set-engine' | 'rescue-world';
  label: string;
  serverType?: string;
  mcVersion?: string;
}

export interface PreflightFinding {
  id: string;
  severity: 'block' | 'warn';
  title: string;
  detail: string;
  fix?: PreflightFix;
}

export interface PreflightReport {
  findings: PreflightFinding[];
  blocked: boolean;
  /** Null when the node could not be reached; the UI must not read that as "all clear". */
  reachable: boolean;
}

/*
 * The loaders the database can actually hold.
 *
 * The node's detector knows NeoForge and Quilt; the ServerType enum does not. A fix button
 * offering one would fail at the point of saving, so the finding is passed through without
 * a fix instead — the problem is still worth naming even when the panel cannot resolve it
 * in one click.
 */
const STORABLE_TYPES = ['VANILLA', 'FABRIC', 'FORGE', 'PAPER', 'PURPUR', 'MODRINTH', 'CURSEFORGE'] as const;
type StorableType = (typeof STORABLE_TYPES)[number];

function storable(value: unknown): value is StorableType {
  return typeof value === 'string' && (STORABLE_TYPES as readonly string[]).includes(value);
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

  const query = new URLSearchParams({
    serverType: server.serverType || '',
    mcVersion: server.mcVersion || '',
  });

  try {
    const daemon = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });
    const data = await daemon.request<{ findings: PreflightFinding[]; blocked: boolean }>(
      `/servers/${server.id}/preflight?${query}`,
      {},
      15000
    );
    // Strip fix buttons the panel could not carry out, rather than offering a click that
    // fails on save.
    const findings = data.findings.map((f) =>
      f.fix?.action === 'set-engine' && f.fix.serverType && !storable(f.fix.serverType)
        ? {
            ...f,
            fix: undefined,
            detail: `${f.detail} This panel cannot store ${f.fix.serverType} as a server type yet, so there is no one-click fix for it.`,
          }
        : f
    );

    return NextResponse.json({ ...data, findings, reachable: true } satisfies PreflightReport);
  } catch (err: any) {
    /*
     * An unreachable node is not a clean bill of health, and must not be shown as one.
     * Reported as reachable:false with no findings so the UI can stay quiet without
     * claiming anything — a node that is down has its own, louder indicator already.
     */
    console.warn('[API /preflight GET]', err.message);
    return NextResponse.json({ findings: [], blocked: false, reachable: false } satisfies PreflightReport);
  }
}

/**
 * Applies one fix.
 *
 * Admin-only: every one of these changes what the server is or moves its world, which is
 * not something a member with start/stop rights should be able to do from a dialog.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await resolveServer(req, params.id);
  if (ctx.error) return ctx.error;
  const { server, user, role, isGlobalAdmin } = ctx;

  if (!isGlobalAdmin && role !== 'OWNER' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden: fixing a server requires admin access' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { action, serverType, mcVersion } = body || {};

  const daemon = new DaemonClient({ host: server.node.host, port: server.node.port, apiKey: server.node.apiKey });

  if (action === 'set-engine') {
    if (serverType !== undefined && !storable(serverType)) {
      return NextResponse.json(
        { error: `${serverType} is not a server type this panel can store.` },
        { status: 400 }
      );
    }
    const nextType: StorableType = storable(serverType) ? serverType : (server.serverType as StorableType);
    const nextVersion = typeof mcVersion === 'string' && mcVersion ? mcVersion : server.mcVersion;

    if (nextType === server.serverType && nextVersion === server.mcVersion) {
      return NextResponse.json({ error: 'That is already what this server is set to.' }, { status: 400 });
    }

    await prisma.server.update({
      where: { id: server.id },
      data: { serverType: nextType, mcVersion: nextVersion },
    });

    await writeAudit({
      userId: user!.userId,
      action: 'SERVER_ENGINE_CORRECTED',
      details: {
        serverId: server.id,
        from: `${server.serverType} ${server.mcVersion}`,
        to: `${nextType} ${nextVersion}`,
        via: 'preflight',
      },
    });

    return NextResponse.json({
      success: true,
      message:
        `This server is now ${nextType} ${nextVersion}. Start it again — the node reinstalls the ` +
        `right loader on the next start.`,
    });
  }

  if (action === 'rescue-world') {
    try {
      const result = await daemon.request<{ message: string; moved: string[] }>(
        `/servers/${server.id}/rescue-world`,
        { method: 'POST' },
        60000
      );

      await writeAudit({
        userId: user!.userId,
        action: 'SERVER_WORLD_RESCUED',
        details: { serverId: server.id, moved: result.moved, via: 'preflight' },
      });

      return NextResponse.json({ success: true, message: result.message });
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Could not move the world aside' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: `Unknown fix: ${action}` }, { status: 400 });
}
