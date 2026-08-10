import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  shareAccessCookie,
  shareCookieName,
  verifySharePassword,
  shareStateMessage,
  ShareState,
} from '@/lib/map-share';

export const dynamic = 'force-dynamic';

interface Ctx {
  params: { token: string; path?: string[] };
}

async function resolveShare(token: string) {
  const share = await prisma.mapShare.findUnique({
    where: { token },
    include: { server: { include: { node: true } } },
  });

  if (!share) return { state: 'not_found' as ShareState, share: null };
  if (!share.enabled) return { state: 'disabled' as ShareState, share };
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
    return { state: 'expired' as ShareState, share };
  }
  if (!share.server.bluemapEnabled || !share.server.bluemapPort) {
    return { state: 'map_off' as ShareState, share };
  }

  return { state: 'ok' as ShareState, share };
}

function page(title: string, bodyHtml: string, status: number): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font-family:system-ui,-apple-system,Segoe UI,sans-serif; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:16px; padding:32px;
          max-width:380px; width:calc(100% - 32px); text-align:center; }
  h1 { font-size:1.1rem; margin:0 0 8px; }
  p { font-size:.85rem; color:#8b949e; margin:0 0 20px; line-height:1.6; }
  input { width:100%; box-sizing:border-box; background:#0d1117; border:1px solid #30363d;
          border-radius:10px; padding:11px 14px; color:#e6edf3; font-size:.9rem; margin-bottom:12px; }
  input:focus { outline:none; border-color:#00d97e; }
  button { width:100%; background:#00d97e; color:#0d1117; border:0; border-radius:10px;
           padding:11px; font-weight:700; font-size:.9rem; cursor:pointer; }
  .err { color:#f85149; font-size:.8rem; margin-bottom:12px; }
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;

  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function passwordPage(token: string, error?: string): NextResponse {
  return page(
    'Map — password required',
    `<h1>🔒 This map is protected</h1>
     <p>Enter the password you were given to view the world map.</p>
     ${error ? `<div class="err">${error}</div>` : ''}
     <form method="POST" action="/map/${encodeURIComponent(token)}">
       <input type="password" name="password" placeholder="Password" autofocus required>
       <button type="submit">View map</button>
     </form>`,
    error ? 401 : 200
  );
}

function unavailablePage(state: ShareState): NextResponse {
  return page(
    'Map unavailable',
    `<h1>🗺️ Map unavailable</h1><p>${shareStateMessage(state)}</p>`,
    state === 'not_found' ? 404 : 410
  );
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const { state, share } = await resolveShare(params.token);
  if (state !== 'ok' || !share) return unavailablePage(state);

  const subPath = (params.path || []).join('/');
  const isRoot = subPath === '' || subPath === 'index.html';

  // Password gate
  if (share.passwordHash) {
    const expected = shareAccessCookie(share.token, share.passwordHash);
    const provided = request.cookies.get(shareCookieName(share.token))?.value;

    if (provided !== expected) {
      // Assets can't render a form; only the entry page prompts
      if (!isRoot) return new NextResponse('Unauthorized', { status: 401 });
      return passwordPage(share.token);
    }
  }

  const node = share.server.node;
  const upstream = `http://${node.host}:${share.server.bluemapPort}/${subPath}${request.nextUrl.search}`;

  try {
    // Range is deliberately not forwarded: the response body gets transparently
    // decompressed here, so a byte range over the compressed form would be meaningless.
    const res = await fetch(upstream, {
      headers: { accept: request.headers.get('accept') || '*/*' },
      cache: 'no-store',
    });

    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    // Count real page views, not every tile fetch
    if (isRoot) {
      prisma.mapShare
        .update({
          where: { id: share.id },
          data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
        })
        .catch(() => {});
    }

    // Rewrite the entry document so relative asset URLs resolve under /map/<token>/
    if (contentType.includes('text/html')) {
      let html = await res.text();
      const base = `/map/${encodeURIComponent(share.token)}/`;

      if (/<base\s/i.test(html)) {
        html = html.replace(/<base\s+href="[^"]*"/i, `<base href="${base}"`);
      } else {
        html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${base}">`);
      }

      return new NextResponse(html, {
        status: res.status,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      });
    }

    const buffer = await res.arrayBuffer();
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'X-Robots-Tag': 'noindex, nofollow',
    };

    // BlueMap stores tiles as pre-gzipped files and serves them with Content-Encoding: gzip.
    // Node's fetch transparently decompresses the body, so forwarding that header would make
    // the browser try to gunzip already-plain bytes and fail. Same for content-range/length,
    // which describe the *compressed* payload we no longer have.
    for (const h of ['accept-ranges', 'cache-control', 'etag']) {
      const v = res.headers.get(h);
      if (v) headers[h === 'etag' ? 'ETag' : h] = v;
    }

    return new NextResponse(buffer, { status: res.status, headers });
  } catch (err: any) {
    if (!isRoot) return new NextResponse('Map backend unreachable', { status: 502 });
    return page(
      'Map offline',
      `<h1>🗺️ Map is offline</h1>
       <p>The server hosting this map isn't responding right now. It may be stopped or still rendering. Try again in a few minutes.</p>`,
      503
    );
  }
}

/** Password submission for a protected share. */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { state, share } = await resolveShare(params.token);
  if (state !== 'ok' || !share) return unavailablePage(state);

  if (!share.passwordHash) {
    return NextResponse.redirect(new URL(`/map/${params.token}/`, request.url));
  }

  const form = await request.formData().catch(() => null);
  const password = String(form?.get('password') || '');

  if (!verifySharePassword(password, share.passwordHash)) {
    return passwordPage(share.token, 'Incorrect password. Try again.');
  }

  const response = NextResponse.redirect(new URL(`/map/${params.token}/`, request.url), 303);
  response.cookies.set(shareCookieName(share.token), shareAccessCookie(share.token, share.passwordHash), {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: `/map/${share.token}`,
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
