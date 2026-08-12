import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!apiKey || apiKey.userId !== user.userId) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 });
  }

  await prisma.apiKey.delete({ where: { id: params.id } });
  return NextResponse.json({ success: true });
}
