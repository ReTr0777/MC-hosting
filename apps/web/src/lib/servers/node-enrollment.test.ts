import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENROLL_TTL_MS,
  TUNNEL_API_PORT_MAX,
  TUNNEL_API_PORT_MIN,
  allocateTunnelPort,
  directCandidates,
  enrollmentUsable,
  generateEnrollCode,
  hashEnrollCode,
  nodeNameFrom,
  normaliseEnrollCode,
} from './node-enrollment';

test('a generated code round-trips through normalisation', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateEnrollCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(normaliseEnrollCode(code), code.replace('-', ''));
    // Whatever the user does to the separators, the same enrollment is found.
    assert.equal(normaliseEnrollCode(code.toLowerCase()), normaliseEnrollCode(code));
    assert.equal(normaliseEnrollCode(` ${code.replace('-', ' ')} `), normaliseEnrollCode(code));
  }
});

test('codes avoid the characters people mistype', () => {
  const joined = Array.from({ length: 200 }, generateEnrollCode).join('');
  for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
    assert.ok(!joined.includes(ambiguous), `code alphabet should not contain ${ambiguous}`);
  }
});

test('nonsense is rejected before it reaches the database', () => {
  assert.equal(normaliseEnrollCode(''), null);
  assert.equal(normaliseEnrollCode(null), null);
  assert.equal(normaliseEnrollCode('ABC'), null, 'too short');
  assert.equal(normaliseEnrollCode('ABCDEFGHJ'), null, 'too long');
  assert.equal(normaliseEnrollCode('ABCD-EFG0'), null, 'character outside the alphabet');
});

test('hashing is stable and code-specific', () => {
  assert.equal(hashEnrollCode('ABCD2345'), hashEnrollCode('ABCD2345'));
  assert.notEqual(hashEnrollCode('ABCD2345'), hashEnrollCode('ABCD2346'));
});

test('an enrollment is usable until it is claimed or expires', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const fresh = { expiresAt: new Date(now.getTime() + ENROLL_TTL_MS), claimedAt: null };
  assert.equal(enrollmentUsable(fresh, now), true);

  assert.equal(
    enrollmentUsable({ expiresAt: new Date(now.getTime() - 1), claimedAt: null }, now),
    false,
    'expired'
  );
  // Single use: a second machine must not be able to redeem the same code.
  assert.equal(enrollmentUsable({ ...fresh, claimedAt: now }, now), false, 'already claimed');
});

test('tunnel ports come from the reserved range and skip what is taken', () => {
  assert.equal(allocateTunnelPort([]), TUNNEL_API_PORT_MIN);
  assert.equal(allocateTunnelPort([TUNNEL_API_PORT_MIN]), TUNNEL_API_PORT_MIN + 1);
  // Game ports live below this range and must not push the allocation around.
  assert.equal(allocateTunnelPort([24000, 25000]), TUNNEL_API_PORT_MIN);

  const everything = [];
  for (let p = TUNNEL_API_PORT_MIN; p <= TUNNEL_API_PORT_MAX; p++) everything.push(p);
  assert.equal(allocateTunnelPort(everything), null, 'exhausted range reports rather than wraps');
});

test('the node name prefers what was asked for, then the hostname', () => {
  assert.equal(nodeNameFrom('Living room PC', 'DESKTOP-8H2K'), 'Living room PC');
  assert.equal(nodeNameFrom('   ', 'DESKTOP-8H2K'), 'DESKTOP-8H2K');
  assert.equal(nodeNameFrom(null, null), 'My machine');
  assert.equal(nodeNameFrom('a'.repeat(200), 'x').length, 60, 'name is capped');
});

test('direct candidates drop addresses that describe the node itself', () => {
  assert.deepEqual(
    directCandidates(['192.168.1.50', '127.0.0.1', 'localhost', '::1', ' 10.0.0.4 ']),
    ['192.168.1.50', '10.0.0.4']
  );
  // Windows gives virtual and unleased adapters a link-local address, and can list one
  // before the real LAN address. Nothing is ever reachable there.
  assert.deepEqual(
    directCandidates(['169.254.83.107', '192.168.50.31', 'fe80::1']),
    ['192.168.50.31']
  );
  assert.deepEqual(directCandidates('not-an-array'), []);
  assert.deepEqual(directCandidates(['bad host/path', 'has space']), []);
});
