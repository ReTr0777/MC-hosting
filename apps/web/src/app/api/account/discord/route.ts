import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';

/**
 * Whether this account is linked to a Discord account, and undoing it.
 *
 * Separate from the link-code route because this is the read the UI does on every page
 * load, while generating a code is a deliberate action that writes a row and invalidates
 * the previous one — a GET should not do that.
 */

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const row = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { discordUserId: true },
  });

  /*
   * The Discord id is returned only to the account it belongs to. It is not a secret — it
   * appears in every mention — but there is no reason for it to be readable by anyone else,
   * and showing it is what lets someone confirm they linked the account they meant to
   * rather than an alt they were signed into at the time.
   */
  return NextResponse.json({
    linked: Boolean(row?.discordUserId),
    discordUserId: row?.discordUserId ?? null,
  });
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await prisma.user.update({ where: { id: user.userId }, data: { discordUserId: null } });
  // Any code still outstanding would re-link on its own otherwise, which is not what
  // someone unlinking a compromised Discord account is asking for.
  await prisma.discordLinkCode.deleteMany({ where: { userId: user.userId } });

  return NextResponse.json({ success: true });
}
