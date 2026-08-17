import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHealthOnline } from './node-status';

/**
 * This predicate decides the ONLINE badge, whether NODE_OFFLINE notifications fire,
 * and whether a node can be picked when creating a server. The cases below are the
 * ways a node can answer, and what each should mean.
 */

const health = (over: Record<string, unknown> = {}) =>
  ({ status: 'ok', dockerAvailable: true, ...over } as never);

test('a healthy node with Docker is online', () => {
  assert.equal(isHealthOnline(health()), true);
});

test('a node without Docker is online — it reports degraded, not dead', () => {
  // The case that prompted this: a phone or a Pi running servers in PROCESS mode.
  // It answers every poll correctly and has no Docker socket to find.
  assert.equal(isHealthOnline(health({ status: 'degraded', dockerAvailable: false })), true);
});

test('a node whose Docker died is online, not offline', () => {
  // It is still reachable and can still start and stop process-mode servers, so
  // reporting it down would hide working servers and fire a false alert.
  assert.equal(isHealthOnline(health({ status: 'degraded', dockerAvailable: false })), true);
});

test('no reply at all is offline', () => {
  assert.equal(isHealthOnline(null), false);
  assert.equal(isHealthOnline(undefined), false);
});

test('a 200 that is not a health report is offline', () => {
  // A captive portal or a tunnel port pointing at the wrong service can answer 200
  // with JSON. Requiring a known status stops that registering as a node.
  assert.equal(isHealthOnline({} as never), false);
  assert.equal(isHealthOnline({ status: 'running' } as never), false);
  assert.equal(isHealthOnline({ status: '' } as never), false);
});

test('dockerAvailable alone no longer decides liveness', () => {
  // The old check was `status === 'ok' || dockerAvailable`. Both halves are gone:
  // an unknown status does not become online just because Docker is reachable.
  assert.equal(isHealthOnline({ status: 'whatever', dockerAvailable: true } as never), false);
});
