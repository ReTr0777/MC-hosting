import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { saveConfig } from '../config';
import { allowanceRefusal, machineCpuCores, machineMemoryMb, resolveAllowance } from './allowance';

/*
 * These run against the machine the tests are on, so they assert relationships rather
 * than fixed numbers — "no more than the hardware has", not "8192".
 */
const PHYSICAL_MEMORY = machineMemoryMb();
const PHYSICAL_CORES = machineCpuCores();

beforeEach(() => {
  saveConfig({ maxMemoryMb: 0, maxCpuCores: 0 });
});

test('an unset limit offers the whole machine', () => {
  const allowance = resolveAllowance();
  assert.equal(allowance.memoryMb, PHYSICAL_MEMORY);
  assert.equal(allowance.cpuCores, PHYSICAL_CORES);
  assert.equal(allowance.capped, false);
});

test('a limit inside the machine is taken as given', () => {
  const half = Math.max(1024, Math.floor(PHYSICAL_MEMORY / 2));
  saveConfig({ maxMemoryMb: half });
  const allowance = resolveAllowance();
  assert.equal(allowance.memoryMb, half);
  assert.equal(allowance.capped, half < PHYSICAL_MEMORY);
});

test('a limit larger than the machine is clamped to it', () => {
  // Reachable by hand-editing config.json. Left alone, it would have the panel place
  // servers this node has no memory to run.
  saveConfig({ maxMemoryMb: PHYSICAL_MEMORY * 4, maxCpuCores: PHYSICAL_CORES * 4 });
  const allowance = resolveAllowance();
  assert.equal(allowance.memoryMb, PHYSICAL_MEMORY);
  assert.equal(allowance.cpuCores, PHYSICAL_CORES);
  assert.equal(allowance.capped, false);
});

test('a limit too small to run anything is raised to the floor', () => {
  saveConfig({ maxMemoryMb: 64, maxCpuCores: 0.01 });
  const allowance = resolveAllowance();
  assert.equal(allowance.memoryMb, 1024);
  assert.equal(allowance.cpuCores, 0.5);
});

test('an uncapped node refuses nothing, however large the server', () => {
  assert.equal(allowanceRefusal(PHYSICAL_MEMORY * 10, PHYSICAL_CORES * 10), null);
});

test('a capped node refuses a server bigger than the whole allowance', () => {
  const half = Math.max(1024, Math.floor(PHYSICAL_MEMORY / 2));
  if (half >= PHYSICAL_MEMORY) return; // A 2 GB CI box cannot be capped below its floor.

  saveConfig({ maxMemoryMb: half });
  const refusal = allowanceRefusal(half + 1024, 1);
  assert.ok(refusal, 'expected a refusal');
  // The message has to say what to change, since it surfaces in the panel as the reason
  // the server would not start.
  assert.match(refusal!, /Resources/);
});

test('a capped node still accepts a server that fits', () => {
  const half = Math.max(1024, Math.floor(PHYSICAL_MEMORY / 2));
  saveConfig({ maxMemoryMb: half });
  assert.equal(allowanceRefusal(1024, 1), null);
});

test('cores are refused on their own account, not only memory', () => {
  if (PHYSICAL_CORES < 2) return;
  saveConfig({ maxCpuCores: 1 });
  const refusal = allowanceRefusal(1024, 2);
  assert.ok(refusal, 'expected a refusal');
  assert.match(refusal!, /cores/i);
});

test('the reported figures never exceed what os reports', () => {
  saveConfig({ maxMemoryMb: PHYSICAL_MEMORY, maxCpuCores: PHYSICAL_CORES });
  const allowance = resolveAllowance();
  assert.ok(allowance.memoryMb <= Math.round(os.totalmem() / (1024 * 1024)));
  assert.ok(allowance.cpuCores <= os.cpus().length);
});
