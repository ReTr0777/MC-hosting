import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

const RANGES: Record<string, number> = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const range = request.nextUrl.searchParams.get('range') || '1h';
  const rangeMs = RANGES[range] ?? RANGES['1h'];

  try {
    const samples = await prisma.serverStatSample.findMany({
      where: { serverId: params.id, createdAt: { gte: new Date(Date.now() - rangeMs) } },
      orderBy: { createdAt: 'asc' },
      select: { cpuPercent: true, memoryMb: true, playerCount: true, createdAt: true },
    });

    return NextResponse.json({ range, samples });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to load stat history' }, { status: 500 });
  }
}
