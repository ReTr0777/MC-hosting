import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { flattenServerDir } from './flatten';

/**
 * Hoisting a pack out of its wrapper folder must not lose files on the way. The case that
 * used to lose them is a directory present on both sides — the pack ships a config/ and the
 * server root already has one — because merging the two shelled out to POSIX `cp`, which a
 * node hosting natively on Windows has no shell to run.
 */

function serverDirWith(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('a wrapper folder is hoisted to the server root', () => {
  const root = serverDirWith({
    'MyPack-1.0/run.sh': '#!/bin/sh\n',
    'MyPack-1.0/mods/new.jar': 'new',
  });
  try {
    flattenServerDir(root);
    assert.ok(fs.existsSync(path.join(root, 'run.sh')));
    assert.deepEqual(fs.readdirSync(path.join(root, 'mods')), ['new.jar']);
    assert.equal(fs.existsSync(path.join(root, 'MyPack-1.0')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory sitting at both the root and inside the wrapper is merged, not dropped', () => {
  const root = serverDirWith({
    // At the root, so the wrapper is found by search rather than by the single-folder collapse.
    'config/server-side.toml': 'kept',
    'MyPack-1.0/run.sh': '#!/bin/sh\n',
    'MyPack-1.0/mods/new.jar': 'new',
    'MyPack-1.0/config/pack.toml': 'packed',
    'MyPack-1.0/config/nested/deep.toml': 'deep',
  });
  try {
    flattenServerDir(root);

    assert.ok(fs.existsSync(path.join(root, 'run.sh')));
    assert.deepEqual(fs.readdirSync(path.join(root, 'mods')), ['new.jar']);

    const config = fs.readdirSync(path.join(root, 'config')).sort();
    assert.deepEqual(config, ['nested', 'pack.toml', 'server-side.toml']);
    assert.equal(fs.readFileSync(path.join(root, 'config', 'nested', 'deep.toml'), 'utf8'), 'deep');
    // What was already on the server survives the merge.
    assert.equal(fs.readFileSync(path.join(root, 'config', 'server-side.toml'), 'utf8'), 'kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
