import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { quotaSnapshot } from '@/lib/servers/quota';

export async function GET(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const snapshot = await quotaSnapshot(authUser.userId);
  if (snapshot.unlimited) {
    return NextResponse.json({ unlimited: true });
  }

  return NextResponse.json(snapshot);
}
