import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { readBuiltinTheme } from '@/lib/theme/builtin-themes';

export const dynamic = 'force-dynamic';

/**
 * Serves one bundled theme file to a signed-in user.
 *
 * This route is the reason the files sit outside `public/` — served statically they would
 * be readable by anyone who can reach the panel.
 */
export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const source = readBuiltinTheme(params.slug);
  if (source === null) return NextResponse.json({ error: 'Theme not found' }, { status: 404 });

  return new NextResponse(source, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      // Signed-in-only content must not be kept by a shared cache.
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${params.slug}.css"`,
    },
  });
}
