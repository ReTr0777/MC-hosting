import { prisma } from '@/lib/prisma';
import { canManageNode, canUseNode, type NodeViewer, type OwnedNode } from '@/lib/servers/node-access';

/**
 * Passing one server between several people's machines.
 *
 * The ordinary rule is that a migration destination has to be a node the mover could have
 * created the server on — the shared fleet, or a machine they enrolled themselves. That is
 * what stops a world being pushed onto somebody else's hardware, and it is also what makes
 * a group of friends unable to take turns hosting the thing they all play on.
 *
 * The pool resolves the two by moving the consent to the right person. The machine's owner
 * volunteers it, once, for one server. After that the server's admins move it between
 * pooled machines without asking again, because the asking already happened and repeating
 * it for every handoff is the friction that would stop anyone doing this at all.
 *
 * What it deliberately is not: a way to gain any other access. Being in a pool lets a
 * server land on that machine. It grants the machine's owner nothing over the server, and
 * the server's admins nothing over the machine.
 */

/**
 * Whether this server may be moved onto this node by this account.
 *
 * The pool is consulted only after the ordinary rule declines, so nothing about existing
 * destinations changes: a fleet node and your own machines stay available whether or not
 * anybody has pooled anything.
 */
export async function canPlaceServerOnNode(
  user: NodeViewer,
  node: OwnedNode & { id: string },
  serverId: string
): Promise<boolean> {
  if (canUseNode(user, node)) return true;

  const pooled = await prisma.serverHostingPoolMember
    .findUnique({ where: { serverId_nodeId: { serverId, nodeId: node.id } }, select: { id: true } })
    .catch(() => null);

  return !!pooled;
}

/**
 * The refusal to send, or null when the placement is allowed.
 *
 * A node that is pooled for a *different* server is still "not available" here rather than
 * "not pooled for this one": which servers somebody has volunteered their machine for is
 * their business, and naming it would leak the shape of other people's arrangements to
 * anyone who can guess a node id.
 */
export async function placementViolation(
  user: NodeViewer,
  node: OwnedNode & { id: string },
  serverId: string
): Promise<string | null> {
  if (await canPlaceServerOnNode(user, node, serverId)) return null;
  return (
    'That machine is not available for this server. Its owner has to add it to the ' +
    "server's hosting pool before anything can be moved onto it."
  );
}

/**
 * Whether this account may volunteer this machine for this server.
 *
 * Two separate rights, and both are required. Owning the machine is what makes the offer
 * meaningful — it is that person's disk. Being on the server is what makes it informed:
 * volunteering hardware for a world you cannot see is not consent, it is a blank cheque.
 */
export async function canPoolNode(
  user: NodeViewer,
  node: OwnedNode,
  serverId: string
): Promise<boolean> {
  if (!canManageNode(user, node)) return false;
  if (user.globalRole === 'GLOBAL_ADMIN') return true;

  const member = await prisma.serverPermission
    .findUnique({
      where: { userId_serverId: { userId: user.userId, serverId } },
      select: { id: true },
    })
    .catch(() => null);

  return !!member;
}
