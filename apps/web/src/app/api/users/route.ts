import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest, hashPassword } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      username: true,
      globalRole: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' }
  });

  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { email, username, password, globalRole } = await req.json();

  if (!email || !username || !password) {
    return NextResponse.json({ error: 'Email, username, and password are required' }, { status: 400 });
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }],
    },
  });

  if (existingUser) {
    return NextResponse.json({ error: 'User already exists' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  
  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash,
      globalRole: globalRole || 'USER',
    },
    select: {
      id: true,
      email: true,
      username: true,
      globalRole: true,
      createdAt: true,
    }
  });

  return NextResponse.json(user);
}
