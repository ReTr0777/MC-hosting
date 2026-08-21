/**
 * Who may see and use which node.
 *
 * A node with no owner is part of the hosting fleet: shared, visible to everyone, and
 * schedulable for anyone. A node with an owner is somebody's own machine, enrolled with
 * a claim code from the desktop app, and it belongs to that account alone.
 *
 * The distinction has to hold in three separate places — the node list, server creation
 * (including the automatic scheduler) and migration destinations — so the rule lives
 * here as plain data rather than being retyped as a `where` clause each time. A dropdown
 * that hides a node is a courtesy; these are the checks that make it true.
 */

export interface NodeViewer {
  userId: string;
  globalRole: string;
}

export interface OwnedNode {
  ownerId?: string | null;
  name?: string;
}

/** A global admin operates the installation, so every machine in it is in scope. */
export function isNodeAdmin(user: NodeViewer): boolean {
  return user.globalRole === 'GLOBAL_ADMIN';
}

/**
 * The `where` fragment restricting a node query to what this account may see.
 *
 * Returns an empty object for an admin — spreading `{}` into a query is a no-op, which
 * keeps every call site a single unconditional spread instead of a branch.
 */
export function visibleNodesWhere(user: NodeViewer): { OR?: Array<{ ownerId: string | null }> } {
  if (isNodeAdmin(user)) return {};
  return { OR: [{ ownerId: null }, { ownerId: user.userId }] };
}

/** Whether this account may see the node at all. */
export function canSeeNode(user: NodeViewer, node: OwnedNode): boolean {
  if (isNodeAdmin(user)) return true;
  return !node.ownerId || node.ownerId === user.userId;
}

/**
 * Whether this account may place or move a server onto the node.
 *
 * The same rule as visibility today, and separate from it on purpose: "you can look at
 * the fleet's capacity" and "you can consume it" are different questions, and the day
 * one of them grows a condition the other should not follow it by accident.
 */
export function canUseNode(user: NodeViewer, node: OwnedNode): boolean {
  return canSeeNode(user, node);
}

/**
 * Whether this account may change or delete the node.
 *
 * An owner administers their own machine — renaming it, correcting its address, draining
 * it, removing it once it is empty — without needing a global admin for every step. They
 * get no say over anyone else's, including the shared fleet.
 */
export function canManageNode(user: NodeViewer, node: OwnedNode): boolean {
  if (isNodeAdmin(user)) return true;
  return !!node.ownerId && node.ownerId === user.userId;
}

/**
 * The refusal to send when a node is not usable, or null when it is.
 *
 * Phrased as "not found" rather than "not yours" because to this account it genuinely is
 * not there: confirming that a node exists but belongs to someone else leaks the shape of
 * other people's setups for no benefit.
 */
export function nodeUseViolation(user: NodeViewer, node: OwnedNode): string | null {
  if (canUseNode(user, node)) return null;
  return 'That node is not available to your account.';
}
