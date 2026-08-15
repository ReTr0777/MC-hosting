import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { CustomTheme, THEME_TOKENS } from '@/lib/theme/theme-tokens';

/**
 * The account's appearance, so a theme chosen on one device shows up on the next.
 *
 * The browser keeps writing localStorage on every change — the pre-paint script in
 * layout.tsx is synchronous and cannot await a fetch, so local storage stays the
 * fast path. This route is the sync layer on top of it.
 *
 * `null` for both fields is meaningful and distinct from "empty": it means this
 * account has never saved an appearance, which is what lets the client offer up
 * whatever it already had locally instead of wiping it.
 */

/** Enough for a good handful of illustrated themes without letting one account store a library. */
const MAX_CUSTOM_THEMES = 20;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Re-validates a theme server-side.
 *
 * The client already parsed the file through `parseThemeFile`, but a request can be
 * made by hand, and these values are written straight into a stylesheet on every
 * page the user loads. Unknown token names are dropped rather than stored.
 */
function sanitizeTheme(value: unknown): CustomTheme | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return null;

  const tokens: Record<string, string> = {};
  const rawTokens = (raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {}) as Record<string, unknown>;
  for (const token of THEME_TOKENS) {
    const v = rawTokens[token];
    if (typeof v === 'string') tokens[token] = v;
  }
  if (Object.keys(tokens).length === 0) return null;

  return {
    id,
    name,
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    scheme: raw.scheme === 'light' ? 'light' : 'dark',
    tokens,
  } as CustomTheme;
}

export async function GET(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: { themeKey: true, customThemes: true },
  });
  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  return NextResponse.json({
    themeKey: user.themeKey,
    customThemes: user.customThemes ?? null,
  });
}

export async function PUT(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const themes = Array.isArray(body?.customThemes)
    ? body.customThemes.map(sanitizeTheme).filter((t: CustomTheme | null): t is CustomTheme => t !== null)
    : [];

  if (themes.length > MAX_CUSTOM_THEMES) {
    return NextResponse.json(
      { error: `You can sync at most ${MAX_CUSTOM_THEMES} custom themes to your account.` },
      { status: 400 }
    );
  }

  const serialized = JSON.stringify(themes);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: 'Those themes are too large to sync. Themes with embedded artwork take the most room.' },
      { status: 413 }
    );
  }

  // Only the `custom:` case is checked here: a key naming a custom theme that is not in
  // this payload would leave the user on a broken selection on their next device. Which
  // built-in keys exist is the client's business — it already falls back to the default
  // for one it does not recognise, so this route does not duplicate that list.
  const requested =
    typeof body?.themeKey === 'string' && body.themeKey.length > 0 && body.themeKey.length <= 128
      ? body.themeKey
      : null;
  const known =
    requested !== null &&
    (!requested.startsWith('custom:') || themes.some((t: CustomTheme) => `custom:${t.id}` === requested));

  await prisma.user.update({
    where: { id: authUser.userId },
    data: {
      themeKey: known ? requested : null,
      customThemes: themes as any,
    },
  });

  return NextResponse.json({ success: true, themeKey: known ? requested : null, count: themes.length });
}
