import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { listBuiltinThemes } from '@/lib/builtin-themes';

export const dynamic = 'force-dynamic';

/** Lists the theme files bundled with the panel. Signed-in users only. */
export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ themes: listBuiltinThemes() });
}
