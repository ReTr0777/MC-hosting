import type { NextRequest } from 'next/server';

/**
 * Works out the address a user would actually type, for links that leave the panel.
 *
 * `req.nextUrl.origin` cannot be used for this. The custom server in `apps/web/server.js`
 * binds Next to the hostname `0.0.0.0`, so `nextUrl` reports `0.0.0.0:3000` — a bind
 * address, not a reachable host. A verification link built from it lands the recipient on
 * ERR_ADDRESS_INVALID.
 *
 * Order of preference:
 *   1. APP_URL, set by the operator. The only option that works when a link is generated
 *      outside a request (a scheduled job, a Discord command) and the only one a reverse
 *      proxy cannot get wrong.
 *   2. X-Forwarded-Host / -Proto, set by the proxy in front of the panel.
 *   3. The Host header, for direct access on the LAN.
 *   4. The request origin, as a last resort.
 */

/** Addresses that name a socket to bind rather than a host anyone can reach. */
const UNREACHABLE_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0']);

export interface OriginSources {
  configured?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  host?: string | null;
  /** Used only when nothing else yields a usable host. */
  fallback: string;
}

export function resolvePublicOrigin(sources: OriginSources): string {
  const configured = (sources.configured || '').trim();
  if (configured) {
    // Tolerate a bare host in the env var rather than silently producing a relative URL.
    const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
    return withScheme.replace(/\/+$/, '');
  }

  // Proxies append to these headers, so the client-facing value is the first entry.
  const firstValue = (raw: string | null | undefined) => (raw || '').split(',')[0].trim();

  const host = firstValue(sources.forwardedHost) || firstValue(sources.host);
  const hostname = host.replace(/:\d+$/, '').toLowerCase();

  if (host && !UNREACHABLE_HOSTS.has(hostname)) {
    // Default to http: direct access to the panel is over http, and anything terminating
    // TLS in front of it sets X-Forwarded-Proto. Guessing https would break LAN links.
    const proto = firstValue(sources.forwardedProto).toLowerCase() === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }

  return sources.fallback.replace(/\/+$/, '');
}

export const PUBLIC_URL_SETTING_KEY = 'PUBLIC_APP_URL';

/**
 * Reads the operator's configured address, preferring the environment variable.
 *
 * The env var wins because it is deployment-level: it is the escape hatch that still works
 * when the database is unreachable or has not been set up yet, which is exactly when a
 * password-reset link matters most.
 */
async function readConfiguredOrigin(): Promise<string> {
  const fromEnv = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  if (fromEnv) return fromEnv;

  try {
    // Imported lazily so this module stays usable (and testable) without a database.
    const { prisma } = await import('@/lib/prisma');
    const row = await prisma.systemSetting.findUnique({ where: { key: PUBLIC_URL_SETTING_KEY } });
    return (row?.value || '').trim();
  } catch {
    // No database, no setting — the request headers still give a usable answer.
    return '';
  }
}

/** Request-bound wrapper around `resolvePublicOrigin`. */
export async function getPublicOrigin(req: NextRequest): Promise<string> {
  return resolvePublicOrigin({
    configured: await readConfiguredOrigin(),
    forwardedHost: req.headers.get('x-forwarded-host'),
    forwardedProto: req.headers.get('x-forwarded-proto'),
    host: req.headers.get('host'),
    fallback: req.nextUrl.origin,
  });
}

/** Rejects anything that would produce a broken link. Empty means "derive it from the request". */
export function validatePublicUrl(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: true, value: '' };

  // Detect a scheme before deciding whether to add one. Testing for `^https?://` alone and
  // otherwise prepending `https://` turns `ftp://example.com` into `https://ftp://example.com`,
  // which parses as host `ftp` and sails through the protocol check below.
  const declaredScheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (declaredScheme && declaredScheme !== 'http' && declaredScheme !== 'https') {
    return { ok: false, error: 'The panel URL must start with http:// or https://' };
  }

  let url: URL;
  try {
    url = new URL(declaredScheme ? value : `https://${value}`);
  } catch {
    return { ok: false, error: 'That is not a valid URL. Use something like https://panel.example.com' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The panel URL must start with http:// or https://' };
  }
  if (!url.hostname || UNREACHABLE_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: `'${url.hostname}' is a bind address, not somewhere a browser can reach.` };
  }
  if (url.search || url.hash) {
    return { ok: false, error: 'The panel URL should not contain a query string or fragment.' };
  }

  // Keep only scheme, host and any base path; a trailing slash would double up.
  const base = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  return { ok: true, value: base };
}
