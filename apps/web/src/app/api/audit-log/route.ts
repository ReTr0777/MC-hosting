import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(params.get('pageSize') || '50', 10) || 50));
  const action = params.get('action');
  const userId = params.get('userId');
  const from = params.get('from');
  const to = params.get('to');

  const where: any = {};
  if (action) where.action = { contains: action, mode: 'insensitive' };
  if (userId) where.userId = userId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  try {
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { username: true, email: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return NextResponse.json({ logs, total, page, pageSize });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch audit log' }, { status: 500 });
  }
}
