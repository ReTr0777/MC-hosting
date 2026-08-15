import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCapacity, capacityViolation, CapacityNode, CapacityServer } from './node-capacity';

/**
 * The distinction that matters here is allocated vs active. Scheduling against active RAM is
 * what let a node accept far more servers than it could ever run at the same time.
 */

function node(overrides: Partial<CapacityNode> = {}): CapacityNode {
  // cpuOvercommitRatio 1 keeps most tests measuring the raw arithmetic; the 4x production default
  // is exercised on its own below.
  return { id: 'n1', name: 'Main', totalMemory: 16384, totalCpu: 8, overcommitRatio: 1, cpuOvercommitRatio: 1, ...overrides };
}

function server(memoryMb: number, cpuLimit: number, status = 'OFFLINE'): CapacityServer {
  return { id: Math.random().toString(36), memoryMb, cpuLimit, status };
}

test('allocation counts every server, active counts only the running ones', () => {
  const capacity = computeCapacity(node(), [
    server(4096, 2, 'RUNNING'),
    server(4096, 2, 'OFFLINE'),
    server(2048, 1, 'STARTING'),
  ]);

  assert.equal(capacity.allocatedMemoryMb, 10240);
  assert.equal(capacity.activeMemoryMb, 6144);
  assert.equal(capacity.allocatedCpu, 5);
  assert.equal(capacity.activeCpu, 3);
  assert.equal(capacity.freeMemoryMb, 6144);
});

test('an offline server still occupies its allocation', () => {
  // The bug this guards: 12 GB of stopped servers on a 16 GB node used to look like an empty node.
  const capacity = computeCapacity(node(), [server(12288, 4, 'OFFLINE')]);
  assert.equal(
    capacityViolation(capacity, { memoryMb: 8192, cpuLimit: 1 })?.includes('does not have room'),
    true
  );
});

test('a server that fits is allowed', () => {
  const capacity = computeCapacity(node(), [server(8192, 4, 'RUNNING')]);
  assert.equal(capacityViolation(capacity, { memoryMb: 8192, cpuLimit: 4 }), null);
});

test('overcommit raises the budget proportionally', () => {
  const capacity = computeCapacity(node({ overcommitRatio: 1.5, cpuOvercommitRatio: 1.5 }), [server(12288, 6)]);
  assert.equal(capacity.memoryBudgetMb, 24576);
  assert.equal(capacity.freeMemoryMb, 12288);
  assert.equal(capacityViolation(capacity, { memoryMb: 12288, cpuLimit: 6 }), null);
});

test('CPU is enforced separately from memory', () => {
  const capacity = computeCapacity(node({ totalCpu: 4 }), [server(1024, 3)]);
  const violation = capacityViolation(capacity, { memoryMb: 1024, cpuLimit: 2 });
  assert.match(violation ?? '', /core/);
});

test('a node registered without a usable total constrains nothing', () => {
  // Unconfigured is not the same as full — refusing everything here would brick the panel.
  const capacity = computeCapacity(node({ totalMemory: 0, totalCpu: 0 }), [server(65536, 32)]);
  assert.equal(capacity.memoryBudgetMb, null);
  assert.equal(capacity.freeMemoryMb, null);
  assert.equal(capacityViolation(capacity, { memoryMb: 65536, cpuLimit: 32 }), null);
});

test('fractional CPU allocations do not drift', () => {
  const capacity = computeCapacity(node({ totalCpu: 4 }), [server(1024, 0.5), server(1024, 0.25), server(1024, 0.1)]);
  assert.equal(capacity.allocatedCpu, 0.85);
  assert.equal(capacity.freeCpu, 3.15);
});

test('CPU budgets are looser than memory budgets by default', () => {
  // The refusal this guards: a 4-core node with a handful of idle servers, each holding a 1-core
  // *ceiling*, used to report itself full while the machine sat near zero load.
  const capacity = computeCapacity(
    { id: 'n1', name: 'Unraid', totalMemory: 65536, totalCpu: 4, overcommitRatio: 1 },
    Array.from({ length: 7 }, () => server(2048, 1))
  );

  assert.equal(capacity.cpuOvercommitRatio, 4);
  assert.equal(capacity.cpuBudget, 16);
  assert.equal(capacityViolation(capacity, { memoryMb: 8192, cpuLimit: 1 }), null);
});

test('a CPU ratio of zero or nonsense falls back to the default rather than freezing the node', () => {
  const capacity = computeCapacity(node({ totalCpu: 4, cpuOvercommitRatio: 0 }), [server(1024, 1)]);
  assert.equal(capacity.cpuBudget, 16);
});

test('a full node reports zero free rather than a negative number', () => {
  const capacity = computeCapacity(node(), [server(20480, 4)]);
  assert.equal(capacity.freeMemoryMb, 0);
});
