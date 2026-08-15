import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaViolation, QuotaSnapshot } from './quota';

/**
 * The quota rules decide whether a server may be created or resized. Resizing in particular is
 * easy to get wrong: the server's own current allocation must not be counted against the budget
 * it is trying to move within, which is why callers exclude it before building the snapshot.
 */

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    unlimited: false,
    maxServers: null, maxMemoryMb: null, maxCpu: null,
    maxServerMemoryMb: null, maxServerCpu: null,
    usedServers: 0, usedMemoryMb: 0, usedCpu: 0,
    memoryCeiling: null, cpuCeiling: null,
    ...overrides,
  };
}

test('an unlimited user is never blocked', () => {
  const s = snapshot({ unlimited: true, maxMemoryMb: 1024, usedMemoryMb: 999999 });
  assert.equal(quotaViolation(s, { memoryMb: 65536, cpuLimit: 16, countsAsNew: true }), null);
});

test('a server within both the per-server and total limits fits', () => {
  const s = snapshot({ maxServers: 3, maxMemoryMb: 16384, maxServerMemoryMb: 8192, usedServers: 1, usedMemoryMb: 4096 });
  assert.equal(quotaViolation(s, { memoryMb: 8192, cpuLimit: 2, countsAsNew: true }), null);
});

test('the per-server memory ceiling is reported before the total budget', () => {
  const s = snapshot({ maxMemoryMb: 65536, maxServerMemoryMb: 4096 });
  assert.match(quotaViolation(s, { memoryMb: 8192, cpuLimit: 1, countsAsNew: true }) ?? '', /a single server/);
});

test('a server that fits per-server but busts the total is refused', () => {
  const s = snapshot({ maxMemoryMb: 16384, maxServerMemoryMb: 8192, usedMemoryMb: 12288 });
  assert.match(quotaViolation(s, { memoryMb: 8192, cpuLimit: 1, countsAsNew: true }) ?? '', /at most 16384 MB total/);
});

test('the server count is only charged for a new server, not a resize', () => {
  const s = snapshot({ maxServers: 2, usedServers: 2 });
  assert.match(quotaViolation(s, { memoryMb: 2048, cpuLimit: 1, countsAsNew: true }) ?? '', /at most 2 server/);
  assert.equal(quotaViolation(s, { memoryMb: 2048, cpuLimit: 1, countsAsNew: false }), null);
});

/** The resize path excludes the server's own allocation, so a same-size save always passes. */
test('a resize within the freed-up budget is allowed', () => {
  // Owner has 16 GB total and two servers of 8 GB; resizing one of them sees only the other.
  const s = snapshot({ maxMemoryMb: 16384, usedMemoryMb: 8192 });
  assert.equal(quotaViolation(s, { memoryMb: 8192, cpuLimit: 1, countsAsNew: false }), null);
  assert.match(quotaViolation(s, { memoryMb: 8193, cpuLimit: 1, countsAsNew: false }) ?? '', /Memory quota exceeded/);
});

test('CPU limits are enforced per server and in total', () => {
  const perServer = snapshot({ maxServerCpu: 2 });
  assert.match(quotaViolation(perServer, { memoryMb: 1024, cpuLimit: 4, countsAsNew: false }) ?? '', /a single server may use at most 2 core/);

  const total = snapshot({ maxCpu: 4, usedCpu: 3 });
  assert.match(quotaViolation(total, { memoryMb: 1024, cpuLimit: 2, countsAsNew: false }) ?? '', /at most 4 core\(s\) total/);
});

test('a fractional CPU allocation is compared numerically, not by string', () => {
  const s = snapshot({ maxCpu: 1.5, usedCpu: 1 });
  assert.equal(quotaViolation(s, { memoryMb: 1024, cpuLimit: 0.5, countsAsNew: false }), null);
  assert.match(quotaViolation(s, { memoryMb: 1024, cpuLimit: 0.75, countsAsNew: false }) ?? '', /CPU quota exceeded/);
});
