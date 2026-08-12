import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (authUser.globalRole === 'GLOBAL_ADMIN') {
    return NextResponse.json({ unlimited: true });
  }

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: { maxServers: true, maxMemoryMb: true, maxCpu: true },
  });

  const ownedServers = await prisma.server.findMany({
    where: { permissions: { some: { userId: authUser.userId, role: 'OWNER' } } },
    select: { memoryMb: true, cpuLimit: true },
  });

  return NextResponse.json({
    unlimited: !user || (user.maxServers == null && user.maxMemoryMb == null && user.maxCpu == null),
    maxServers: user?.maxServers ?? null,
    maxMemoryMb: user?.maxMemoryMb ?? null,
    maxCpu: user?.maxCpu ?? null,
    usedServers: ownedServers.length,
    usedMemoryMb: ownedServers.reduce((sum: number, s: any) => sum + s.memoryMb, 0),
    usedCpu: ownedServers.reduce((sum: number, s: any) => sum + s.cpuLimit, 0),
  });
}
