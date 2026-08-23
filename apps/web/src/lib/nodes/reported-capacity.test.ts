import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportedCapacityPatch } from './reported-capacity';

/** A health report carrying only the two fields this function reads. */
function health(memoryTotal: number, allowance?: { memoryMb: number; cpuCores: number; capped: boolean }) {
  return {
    memoryUsage: { used: 0, total: memoryTotal, free: memoryTotal, swapUsed: 0, swapTotal: 0 },
    allowance,
  };
}

test('a node with no allowance still reports its hardware, as it always did', () => {
  assert.deepEqual(reportedCapacityPatch(health(32768)), { totalMemory: 32768 });
});

test('an uncapped node reports its hardware, not the allowance echoing it back', () => {
  // capped:false means the figures are just the machine's own. Writing totalCpu here
  // would silently overwrite a value an operator set by hand on a node they never capped.
  const patch = reportedCapacityPatch(health(32768, { memoryMb: 32768, cpuCores: 16, capped: false }));
  assert.deepEqual(patch, { totalMemory: 32768 });
});

test('a capped node reports what it offers, not what it has', () => {
  // The regression this exists for: the poll used to write 32768 here every few seconds,
  // and the scheduler went on filling a machine whose owner had offered a quarter of it.
  const patch = reportedCapacityPatch(health(32768, { memoryMb: 8192, cpuCores: 4, capped: true }));
  assert.deepEqual(patch, { totalMemory: 8192, totalCpu: 4 });
});

test('a fractional core allowance rounds down, never handing back a core held in reserve', () => {
  const patch = reportedCapacityPatch(health(16384, { memoryMb: 4096, cpuCores: 2.5, capped: true }));
  assert.equal(patch.totalCpu, 2);
});

test('an allowance below one core still leaves the node able to hold something', () => {
  // floor(0.5) is 0, and a node registered with zero cores can never be placed on —
  // it would drop out of the scheduler entirely rather than take small servers.
  const patch = reportedCapacityPatch(health(16384, { memoryMb: 2048, cpuCores: 0.5, capped: true }));
  assert.equal(patch.totalCpu, 1);
});

test('a node that answered nothing leaves the stored capacity alone', () => {
  assert.deepEqual(reportedCapacityPatch(null), {});
  assert.deepEqual(reportedCapacityPatch(undefined), {});
});
