import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

function generateRandomCode(length: number = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const invites = await prisma.inviteCode.findMany({
    include: {
      creator: {
        select: { username: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  return NextResponse.json(invites);
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { maxUses } = await req.json().catch(() => ({}));

  const code = generateRandomCode(12);

  const invite = await prisma.inviteCode.create({
    data: {
      code,
      maxUses: maxUses ? parseInt(maxUses) : null,
      createdBy: user.userId,
    }
  });

  await writeAudit({ userId: user.userId, action: 'INVITE_CREATE', details: { inviteId: invite.id, maxUses: invite.maxUses } });

  return NextResponse.json(invite);
}
