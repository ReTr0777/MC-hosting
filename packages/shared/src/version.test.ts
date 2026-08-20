import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, daemonVersionState, MIN_SUPPORTED_DAEMON_VERSION } from './version';

/**
 * The case this exists for: a node running a daemon old enough to lack an endpoint the
 * panel calls. The failure that reaches the operator is otherwise an error about the
 * feature — "could not change what this node hosts" — rather than about the node being
 * out of date, which is the thing they would need to know to fix it.
 */

test('orders versions by segment, not lexically', () => {
  // The lexical trap: "1.2.9" > "1.2.15" as strings, and every version past .9 is wrong.
  assert.equal(compareVersions('1.2.15', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.9', '1.2.15'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('treats equal versions as equal however they are written', () => {
  assert.equal(compareVersions('1.2.15', '1.2.15'), 0);
  assert.equal(compareVersions('v1.2.15', '1.2.15'), 0);
  assert.equal(compareVersions(' 1.2.15 ', '1.2.15'), 0);
});

test('pads missing segments rather than misordering them', () => {
  assert.equal(compareVersions('1.3', '1.3.0'), 0);
  assert.equal(compareVersions('1.3', '1.3.1'), -1);
  assert.equal(compareVersions('2', '1.9.9'), 1);
});

test('survives versions it does not understand', () => {
  // These arrive from a node the panel does not control. Throwing here would take down a
  // health check over a build tag.
  assert.doesNotThrow(() => compareVersions('1.2.15-rc.1', '1.2.15'));
  assert.doesNotThrow(() => compareVersions('not-a-version', '1.2.15'));
  assert.equal(compareVersions('1.2.15-rc.1', '1.2.15'), -1);
  assert.equal(compareVersions('nonsense', '0.0.0'), 0);
});

test('classifies a daemon against the minimum the panel supports', () => {
  assert.equal(daemonVersionState('1.2.15', '1.2.15'), 'current');
  assert.equal(daemonVersionState('1.3.0', '1.2.15'), 'ahead');
  assert.equal(daemonVersionState('1.2.14', '1.2.15'), 'outdated');
});

test('a daemon that reports no version is unknown, not outdated', () => {
  // It is almost certainly old, but the panel cannot say how old, and reporting a
  // specific verdict it cannot support would be worse than admitting the gap.
  assert.equal(daemonVersionState(null), 'unknown');
  assert.equal(daemonVersionState(undefined), 'unknown');
  assert.equal(daemonVersionState(''), 'unknown');
});

test('the shipped minimum is itself a valid version', () => {
  // Guards against a typo in the constant silently making every node read as ahead.
  assert.equal(daemonVersionState(MIN_SUPPORTED_DAEMON_VERSION), 'current');
  assert.match(MIN_SUPPORTED_DAEMON_VERSION, /^\d+\.\d+\.\d+$/);
});
