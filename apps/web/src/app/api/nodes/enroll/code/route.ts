import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { getPublicOrigin } from '@/lib/utils/public-url';
import {
  ENROLL_TTL_MS,
  generateEnrollCode,
  hashEnrollCode,
} from '@/lib/servers/node-enrollment';

export const dynamic = 'force-dynamic';

/** One person cannot need more than this many machines waiting to enroll at once. */
const MAX_OUTSTANDING = 5;

/**
 * Issues a claim code for a machine the user is about to install the node app on.
 *
 * Any signed-in account may do this: the node it produces is private to them, costs the
 * installation nothing, and adds capacity rather than consuming it. What it does not do
 * is grant access to anything — the code names no node and carries no key until a machine
 * redeems it.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : '';

  // Expired codes are dead weight, and clearing them here keeps the outstanding count
  // below about what the user can actually see on screen.
  await prisma.nodeEnrollment.deleteMany({
    where: { userId: user.userId, claimedAt: null, expiresAt: { lt: new Date() } },
  });

  const outstanding = await prisma.nodeEnrollment.count({
    where: { userId: user.userId, claimedAt: null, expiresAt: { gt: new Date() } },
  });
  if (outstanding >= MAX_OUTSTANDING) {
    return NextResponse.json(
      {
        error:
          `You already have ${outstanding} codes waiting to be used. ` +
          'Use one, or wait for them to expire, before asking for another.',
      },
      { status: 429 }
    );
  }

  const code = generateEnrollCode();
  const enrollment = await prisma.nodeEnrollment.create({
    data: {
      codeHash: hashEnrollCode(code.replace('-', '')),
      userId: user.userId,
      name: name || null,
      expiresAt: new Date(Date.now() + ENROLL_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  });

  await writeAudit({
    userId: user.userId,
    action: 'NODE_ENROLL_CODE',
    details: { enrollmentId: enrollment.id, name: name || null },
  });

  return NextResponse.json(
    {
      // The one time this exists outside the user's screen. Only the hash is stored.
      code,
      enrollmentId: enrollment.id,
      expiresAt: enrollment.expiresAt,
      panelUrl: await getPublicOrigin(req),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Whether a code has been redeemed yet, so the panel can stop showing it and point at
 * the node instead. Polled by the "connect a machine" dialog while it is open.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'An enrollment id is required' }, { status: 400 });
  }

  const enrollment = await prisma.nodeEnrollment.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      claimedAt: true,
      node: { select: { id: true, name: true, host: true, port: true, isOnline: true } },
    },
  });

  // Someone else's enrollment is not theirs to watch, and saying it exists says who is
  // setting up what.
  if (!enrollment || enrollment.userId !== user.userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(
    {
      claimed: !!enrollment.claimedAt,
      expired: !enrollment.claimedAt && enrollment.expiresAt.getTime() < Date.now(),
      expiresAt: enrollment.expiresAt,
      node: enrollment.node,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
