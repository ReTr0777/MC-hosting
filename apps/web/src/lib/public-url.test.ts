import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicOrigin, validatePublicUrl } from './public-url';

/**
 * These links are the only thing standing between a user and a locked-out account, and a
 * wrong one is invisible until someone clicks it in an email. The bind-address case is the
 * one that shipped broken.
 */

const FALLBACK = 'https://0.0.0.0:3000';

test('never emits the bind address, whatever the fallback says', () => {
  const origin = resolvePublicOrigin({ host: '0.0.0.0:3000', fallback: FALLBACK });
  // Nothing usable was supplied, so the fallback is all there is — but the moment any real
  // host arrives it must win.
  assert.equal(origin, FALLBACK);

  assert.equal(
    resolvePublicOrigin({ host: 'panel.example.com', fallback: FALLBACK }),
    'http://panel.example.com'
  );
});

test('APP_URL wins over every header', () => {
  assert.equal(
    resolvePublicOrigin({
      configured: 'https://retr0net.nl',
      forwardedHost: 'somewhere.else',
      host: '192.168.50.220:3000',
      fallback: FALLBACK,
    }),
    'https://retr0net.nl'
  );

  // A trailing slash would double up against the path that gets appended.
  assert.equal(resolvePublicOrigin({ configured: 'https://retr0net.nl/', fallback: FALLBACK }), 'https://retr0net.nl');
  // A bare host is tolerated rather than producing a relative link.
  assert.equal(resolvePublicOrigin({ configured: 'retr0net.nl', fallback: FALLBACK }), 'https://retr0net.nl');
});

test('honours a reverse proxy', () => {
  assert.equal(
    resolvePublicOrigin({
      forwardedHost: 'retr0net.nl',
      forwardedProto: 'https',
      host: '192.168.50.220:3000',
      fallback: FALLBACK,
    }),
    'https://retr0net.nl'
  );

  // Proxies append, so only the first hop is client-facing.
  assert.equal(
    resolvePublicOrigin({
      forwardedHost: 'retr0net.nl, internal.lan',
      forwardedProto: 'https, http',
      fallback: FALLBACK,
    }),
    'https://retr0net.nl'
  );
});

test('direct LAN access stays on http', () => {
  // Guessing https here would produce a link that cannot connect.
  assert.equal(
    resolvePublicOrigin({ host: '192.168.50.220:3000', fallback: FALLBACK }),
    'http://192.168.50.220:3000'
  );
});

test('ignores unreachable hosts in favour of anything real', () => {
  for (const host of ['0.0.0.0:3000', '::', '[::]', '']) {
    const origin = resolvePublicOrigin({ host, forwardedHost: 'retr0net.nl', fallback: FALLBACK });
    assert.equal(origin, 'http://retr0net.nl', `${host} should not be used as a link host`);
  }
});

/* ── Validation of the operator-supplied value ─────────────────────────────── */

test('accepts a sensible panel URL and normalises it', () => {
  const cases: Array<[string, string]> = [
    ['https://retr0net.nl', 'https://retr0net.nl'],
    ['https://retr0net.nl/', 'https://retr0net.nl'],
    ['http://192.168.50.220:3000', 'http://192.168.50.220:3000'],
    // A bare host is a reasonable thing to type; assume TLS rather than rejecting it.
    ['retr0net.nl', 'https://retr0net.nl'],
    ['https://example.com/panel/', 'https://example.com/panel'],
    ['', ''],
    ['   ', ''],
  ];

  for (const [input, expected] of cases) {
    const result = validatePublicUrl(input);
    assert.equal(result.ok, true, `${input} should be accepted`);
    if (result.ok) assert.equal(result.value, expected);
  }
});

test('rejects values that would produce an unopenable link', () => {
  for (const bad of [
    'http://0.0.0.0:3000',   // the exact bug this whole helper exists for
    'ftp://example.com',
    'javascript:alert(1)',
    'https://example.com?next=x',
    'not a url at all',
  ]) {
    const result = validatePublicUrl(bad);
    assert.equal(result.ok, false, `${bad} should be rejected`);
  }
});
