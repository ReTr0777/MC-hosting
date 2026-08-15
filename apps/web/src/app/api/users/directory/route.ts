import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Usernames only, for any signed-in user.
 *
 * /api/users is admin-only and returns emails and quotas, which is right for the admin screens
 * but leaves an ordinary owner with no way to name the person they want to hand a server to.
 * This is the minimum needed to pick somebody: an id and the name they are known by.
 *
 * Suspended accounts are left out — they cannot receive a server anyway.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const users = await prisma.user.findMany({
    where: { suspendedAt: null },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });

  return NextResponse.json({ users });
}
