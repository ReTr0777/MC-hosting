import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dirStats } from './dir-stats';

/**
 * These counts decide whether a migration deletes the source copy of a world, so the
 * property that matters is that a directory missing files can never measure the same
 * as one holding them.
 */

function tmpTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirstats-'));
  fs.writeFileSync(path.join(root, 'server.properties'), 'x'.repeat(100));
  fs.mkdirSync(path.join(root, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'y'.repeat(500));
  fs.writeFileSync(path.join(root, 'world', 'region', 'r.0.0.mca'), 'z'.repeat(4000));
  return root;
}

test('every file at every depth is counted, with its bytes', () => {
  const root = tmpTree();
  try {
    assert.deepEqual(dirStats(root), { files: 3, bytes: 4600 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing file shows up as fewer files and fewer bytes', () => {
  // The migration case exactly: a transfer that dropped a region file must not
  // measure equal to one that did not.
  const root = tmpTree();
  try {
    const full = dirStats(root);
    fs.rmSync(path.join(root, 'world', 'region', 'r.0.0.mca'));
    const partial = dirStats(root);

    assert.ok(partial.files < full.files);
    assert.ok(partial.bytes < full.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated file keeps the count but loses bytes', () => {
  // Why both numbers are compared rather than either alone.
  const root = tmpTree();
  try {
    const full = dirStats(root);
    fs.writeFileSync(path.join(root, 'world', 'region', 'r.0.0.mca'), 'z'.repeat(10));
    const truncated = dirStats(root);

    assert.equal(truncated.files, full.files);
    assert.ok(truncated.bytes < full.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('empty directories contribute nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirstats-'));
  try {
    fs.mkdirSync(path.join(root, 'plugins', 'nested'), { recursive: true });
    assert.deepEqual(dirStats(root), { files: 0, bytes: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory that does not exist is zero rather than a throw', () => {
  // Asked of a destination that never received anything, where the honest answer is
  // "nothing is here" and an exception would just become an unexplained failure.
  assert.deepEqual(dirStats(path.join(os.tmpdir(), 'dirstats-does-not-exist-' + Date.now())), {
    files: 0,
    bytes: 0,
  });
});
