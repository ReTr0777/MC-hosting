import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { canPoolNode } from '@/lib/servers/hosting-pool';

export const dynamic = 'force-dynamic';

/**
 * The machines a server's members have volunteered to host it on.
 *
 * Read by anyone who can see the server, written only by the owner of the machine being
 * volunteered — see canPoolNode. That split is the whole point: the people who want the
 * server moved are not the people whose disk it lands on.
 */

/** Everyone on the server may see where it is allowed to live; that is not a secret from them. */
async function viewerRole(userId: string, serverId: string): Promise<string | null> {
  const perm = await prisma.serverPermission.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { role: true },
  });
  return perm?.role ?? null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = user.globalRole === 'GLOBAL_ADMIN';
  if (!isAdmin && !(await viewerRole(user.userId, params.id))) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const members = await prisma.serverHostingPoolMember.findMany({
    where: { serverId: params.id },
    orderBy: { createdAt: 'asc' },
    select: {
      nodeId: true,
      createdAt: true,
      node: { select: { name: true, isOnline: true, ownerId: true } },
    },
  });

  /*
   * Owner usernames rather than ids: this list is read by people deciding where to send a
   * world, and "Bodhi's PC" is the question they are actually asking.
   */
  const ownerIds = Array.from(
    new Set(members.map((m) => m.node.ownerId).filter((id): id is string => !!id))
  );
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, username: true },
      })
    : [];
  const usernameById = new Map(owners.map((o) => [o.id, o.username]));

  return NextResponse.json({
    pool: members.map((m) => ({
      nodeId: m.nodeId,
      nodeName: m.node.name,
      isOnline: m.node.isOnline,
      ownerName: m.node.ownerId ? usernameById.get(m.node.ownerId) ?? null : null,
      addedAt: m.createdAt,
    })),
  });
}

/** Volunteers a machine. Idempotent: offering twice is not an error, it is the same offer. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
  if (!nodeId) return NextResponse.json({ error: 'A nodeId is required' }, { status: 400 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    select: { id: true, name: true },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, name: true, ownerId: true },
  });
  // "Not found" rather than "not yours", as everywhere else a node is addressed by id.
  if (!node) return NextResponse.json({ error: 'Node not found' }, { status: 404 });

  if (!(await canPoolNode(user, node, server.id))) {
    return NextResponse.json(
      {
        error:
          'Only the owner of a machine can offer it to a server, and only for a server they ' +
          'are a member of.',
      },
      { status: 403 }
    );
  }

  await prisma.serverHostingPoolMember.upsert({
    where: { serverId_nodeId: { serverId: server.id, nodeId: node.id } },
    create: { serverId: server.id, nodeId: node.id, addedById: user.userId },
    update: {},
  });

  await writeAudit({
    userId: user.userId,
    action: 'SERVER_POOL_ADD',
    details: { serverId: server.id, nodeId: node.id, nodeName: node.name },
  });

  return NextResponse.json({ pooled: true });
}

/**
 * Withdraws a machine.
 *
 * Only a permission is removed. A server currently running there is deliberately left
 * alone: yanking a world off somebody's disk the moment they change their mind about
 * future handoffs would stop a running game dead, and the owner who wants it gone can
 * ask for it to be moved — which is the same operation as any other handoff.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const nodeId = req.nextUrl.searchParams.get('nodeId') || '';
  if (!nodeId) return NextResponse.json({ error: 'A nodeId is required' }, { status: 400 });

  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, name: true, ownerId: true },
  });
  if (!node) return NextResponse.json({ error: 'Node not found' }, { status: 404 });

  if (!(await canPoolNode(user, node, params.id))) {
    return NextResponse.json({ error: 'That machine is not yours to withdraw.' }, { status: 403 });
  }

  const removed = await prisma.serverHostingPoolMember.deleteMany({
    where: { serverId: params.id, nodeId },
  });

  if (removed.count > 0) {
    await writeAudit({
      userId: user.userId,
      action: 'SERVER_POOL_REMOVE',
      details: { serverId: params.id, nodeId, nodeName: node.name },
    });
  }

  return NextResponse.json({ pooled: false });
}
