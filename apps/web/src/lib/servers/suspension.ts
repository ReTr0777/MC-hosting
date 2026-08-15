import { prisma } from '@/lib/prisma';

/**
 * Suspension: the middle ground between "leave them alone" and "delete everything".
 *
 * Until now the only lever against an abusive or non-paying account was deletion, which
 * destroys worlds and is unappealable. A suspension freezes access — no sign-in, no starting
 * servers — while every byte stays exactly where it is, so lifting it is a single click.
 *
 * Two independent switches:
 *   - a suspended *user* cannot sign in at all, and their live sessions stop working
 *   - a suspended *server* cannot start, wake, or be started by a schedule, whoever asks
 *
 * Either one blocks a start, so suspending a user does not require touching their servers.
 */

export interface SuspensionState {
  suspendedAt: Date | null;
  suspendedReason: string | null;
}

function withReason(prefix: string, reason: string | null): string {
  return reason ? `${prefix} Reason: ${reason}` : prefix;
}

export function userSuspensionMessage(user: SuspensionState): string | null {
  if (!user.suspendedAt) return null;
  return withReason(
    'This account is suspended. Contact an administrator to have it restored.',
    user.suspendedReason
  );
}

export function serverSuspensionMessage(server: SuspensionState): string | null {
  if (!server.suspendedAt) return null;
  return withReason(
    'This server is suspended and cannot be started. Its world and files are untouched.',
    server.suspendedReason
  );
}

/**
 * Why this server may not start, or null if it may. Pure so the precedence — the server's own
 * suspension is reported before its owner's — is testable.
 */
export function startBlockReason(server: SuspensionState, owner: SuspensionState | null): string | null {
  const serverBlock = serverSuspensionMessage(server);
  if (serverBlock) return serverBlock;

  if (owner?.suspendedAt) {
    return withReason(
      'The owner of this server is suspended, so it cannot be started.',
      owner.suspendedReason
    );
  }

  return null;
}

/**
 * Loads the server and its owner and applies {@link startBlockReason}. Every path that can put
 * a server into a running state calls this: the start/restart action, wake, and the scheduler.
 */
export async function serverStartBlock(serverId: string): Promise<string | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: {
      suspendedAt: true,
      suspendedReason: true,
      permissions: {
        where: { role: 'OWNER' },
        select: { user: { select: { suspendedAt: true, suspendedReason: true } } },
      },
    },
  });
  if (!server) return null;

  return startBlockReason(server, server.permissions[0]?.user ?? null);
}

/** True if the account is suspended. Used on every authenticated request, so it selects two fields. */
export async function isUserSuspended(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  });
  return !!user?.suspendedAt;
}
