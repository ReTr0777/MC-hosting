import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBlockReason, userSuspensionMessage } from './suspension';

const ACTIVE = { suspendedAt: null, suspendedReason: null };
const SUSPENDED = { suspendedAt: new Date('2026-08-01T00:00:00Z'), suspendedReason: 'Chargeback' };

test('an active server owned by an active user may start', () => {
  assert.equal(startBlockReason(ACTIVE, ACTIVE), null);
});

test('a suspended server is blocked whoever owns it', () => {
  assert.match(startBlockReason(SUSPENDED, ACTIVE) ?? '', /server is suspended/);
});

test('a suspended owner blocks their servers', () => {
  const block = startBlockReason(ACTIVE, SUSPENDED);
  assert.match(block ?? '', /owner of this server is suspended/);
  assert.match(block ?? '', /Chargeback/);
});

test('the server\'s own suspension is reported ahead of the owner\'s', () => {
  // Both are true; the actionable one is the reason attached to this server.
  assert.match(startBlockReason(SUSPENDED, SUSPENDED) ?? '', /server is suspended/);
});

test('a server with no owner is judged on its own state alone', () => {
  assert.equal(startBlockReason(ACTIVE, null), null);
  assert.match(startBlockReason(SUSPENDED, null) ?? '', /suspended/);
});

test('a reasonless suspension still produces a message', () => {
  const message = userSuspensionMessage({ suspendedAt: new Date(), suspendedReason: null });
  assert.match(message ?? '', /account is suspended/);
  assert.equal(message?.includes('Reason:'), false);
});
