import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  if (!isGlobalAdmin) {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        globalRole: true,
        createdAt: true,
      },
      orderBy: { username: 'asc' },
    });
    return NextResponse.json({ users });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch users' }, { status: 500 });
  }
}
