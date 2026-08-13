import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, listRevisions, readRevision, forgetHistory, isVersionable, HISTORY_DIR } from './file-history';

function makeServerDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-history-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test('a snapshot captures the contents as they were before the edit', () => {
  const dir = makeServerDir({ 'server.properties': 'difficulty=easy\n' });

  const revision = snapshot(dir, 'server.properties');
  assert.ok(revision, 'a snapshot should have been taken');

  fs.writeFileSync(path.join(dir, 'server.properties'), 'difficulty=hard\n');

  assert.equal(readRevision(dir, 'server.properties', revision!.id), 'difficulty=easy\n');
});

test('saving without changing anything does not consume a revision slot', () => {
  const dir = makeServerDir({ 'config/mod.toml': 'a = 1\n' });

  assert.ok(snapshot(dir, 'config/mod.toml'));
  assert.equal(snapshot(dir, 'config/mod.toml'), null, 'identical contents should be skipped');
  assert.equal(listRevisions(dir, 'config/mod.toml').length, 1);
});

test('revisions are listed newest first', () => {
  const dir = makeServerDir({ 'server.properties': 'v1' });

  snapshot(dir, 'server.properties');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'v2');
  snapshot(dir, 'server.properties');

  const revisions = listRevisions(dir, 'server.properties');
  assert.equal(revisions.length, 2);
  assert.equal(readRevision(dir, 'server.properties', revisions[0].id), 'v2');
  assert.equal(readRevision(dir, 'server.properties', revisions[1].id), 'v1');
});

/**
 * An index entry whose snapshot has been trimmed away would show in the panel as a version that
 * fails to open, so the two have to be trimmed together.
 */
test('trimming old revisions deletes their stored contents too', () => {
  const dir = makeServerDir({ 'server.properties': 'v0' });

  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(dir, 'server.properties'), `v${i}`);
    snapshot(dir, 'server.properties');
  }

  const revisions = listRevisions(dir, 'server.properties');
  assert.equal(revisions.length, 15, 'the history is capped');

  for (const revision of revisions) {
    assert.notEqual(readRevision(dir, 'server.properties', revision.id), null, `${revision.id} must still open`);
  }

  // Nothing but the surviving snapshots and the index should be left on disk.
  const historyDirs = fs.readdirSync(path.join(dir, HISTORY_DIR));
  const stored = fs.readdirSync(path.join(dir, HISTORY_DIR, historyDirs[0])).filter((f) => f.endsWith('.snap'));
  assert.equal(stored.length, 15);
});

test('binary and oversized files are not versioned', () => {
  const dir = makeServerDir({ 'mods/some.jar': 'not really a jar', 'world/region.mca': 'binary' });

  assert.equal(snapshot(dir, 'mods/some.jar'), null);
  assert.equal(snapshot(dir, 'world/region.mca'), null);
  assert.equal(listRevisions(dir, 'mods/some.jar').length, 0);
});

test('isVersionable covers the config formats mods actually ship', () => {
  for (const name of ['server.properties', 'config/a.toml', 'config/b.json5', 'kubejs/c.js', 'data.snbt']) {
    assert.ok(isVersionable(name), `${name} should be versionable`);
  }
  for (const name of ['mods/a.jar', 'world/level.dat', 'icon.png']) {
    assert.ok(!isVersionable(name), `${name} should not be versionable`);
  }
});

test('a file that does not exist yet has nothing to snapshot', () => {
  const dir = makeServerDir();
  assert.equal(snapshot(dir, 'server.properties'), null);
});

test('an unknown revision id reads back as null rather than throwing', () => {
  const dir = makeServerDir({ 'server.properties': 'v1' });
  snapshot(dir, 'server.properties');

  assert.equal(readRevision(dir, 'server.properties', 'made-up-id'), null);
});

test('deleting a file forgets its history', () => {
  const dir = makeServerDir({ 'config/mod.toml': 'a = 1\n' });
  snapshot(dir, 'config/mod.toml');
  assert.equal(listRevisions(dir, 'config/mod.toml').length, 1);

  forgetHistory(dir, 'config/mod.toml');
  assert.equal(listRevisions(dir, 'config/mod.toml').length, 0);
});

test('two files with the same basename keep separate histories', () => {
  const dir = makeServerDir({ 'config/a/mod.toml': 'first', 'config/b/mod.toml': 'second' });

  snapshot(dir, 'config/a/mod.toml');
  snapshot(dir, 'config/b/mod.toml');

  const a = listRevisions(dir, 'config/a/mod.toml');
  const b = listRevisions(dir, 'config/b/mod.toml');

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(readRevision(dir, 'config/a/mod.toml', a[0].id), 'first');
  assert.equal(readRevision(dir, 'config/b/mod.toml', b[0].id), 'second');
});

/** The editor sends forward slashes; the daemon may be running on Windows. */
test('path separators do not fork a file into two histories', () => {
  const dir = makeServerDir({ 'config/mod.toml': 'a = 1\n' });

  snapshot(dir, 'config/mod.toml');
  fs.writeFileSync(path.join(dir, 'config/mod.toml'), 'a = 2\n');
  snapshot(dir, 'config\\mod.toml');

  assert.equal(listRevisions(dir, 'config/mod.toml').length, 2);
});
