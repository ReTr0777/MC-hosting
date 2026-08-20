import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Game } from '@mc-manager/shared';
import AdmZip from 'adm-zip';
import { gameOfServerDir, archiveDirectory, EXCLUDED_FROM_BACKUP } from './backup';

/*
 * The cross-game restore guard has two failure modes and they pull in opposite
 * directions. Too lax and a Minecraft world tarball gets unpacked over a
 * Terraria server, destroying it. Too strict and every backup taken before the
 * `game` field existed becomes unrestorable — a Minecraft regression, which the
 * isolation contract forbids outright. These tests pin down the second one,
 * because it is the failure that would ship quietly.
 */

function serverDirWith(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-test-'));
  if (contents !== null) {
    fs.writeFileSync(path.join(dir, 'craftcontrol-meta.json'), contents);
  }
  return dir;
}

test('a server directory with no metadata at all is Minecraft', () => {
  assert.equal(gameOfServerDir(serverDirWith(null)), Game.MINECRAFT);
});

test('metadata predating the game field is Minecraft, not unknown', () => {
  // This is the exact shape every server created before Phase 2 has on disk.
  const legacy = JSON.stringify({ serverId: 'x', serverType: 'FABRIC', mcVersion: '1.20.1' });
  assert.equal(gameOfServerDir(serverDirWith(legacy)), Game.MINECRAFT);
});

test('corrupt metadata degrades to Minecraft rather than refusing the restore', () => {
  assert.equal(gameOfServerDir(serverDirWith('{ this is not json')), Game.MINECRAFT);
  assert.equal(gameOfServerDir(serverDirWith('')), Game.MINECRAFT);
});

test('an unrecognised game is Minecraft, so a downgraded daemon still restores', () => {
  const future = JSON.stringify({ serverId: 'x', game: 'SATISFACTORY' });
  assert.equal(gameOfServerDir(serverDirWith(future)), Game.MINECRAFT);
});

test('an explicit game is honoured', () => {
  assert.equal(
    gameOfServerDir(serverDirWith(JSON.stringify({ serverId: 'x', game: 'TERRARIA' }))),
    Game.TERRARIA
  );
  assert.equal(
    gameOfServerDir(serverDirWith(JSON.stringify({ serverId: 'x', game: 'MINECRAFT' }))),
    Game.MINECRAFT
  );
});

/*
 * Archiving. The failure that prompted these was not a wrong file in the zip — it was an
 * 8 GB server compressed synchronously in-process, freezing the daemon so thoroughly that
 * the panel recorded the node as offline, and leaving a zero-byte archive behind when it
 * gave up.
 */

test('backups never contain the backups directory', () => {
  /*
   * The recursive trap: include `backups/` and every nightly archive contains all of its
   * predecessors, so the directory roughly doubles each night until the disk fills. Nothing
   * about the resulting file looks wrong — it is a valid archive, just enormous.
   */
  assert.ok(EXCLUDED_FROM_BACKUP.includes('backups'), 'backups/ must be excluded');
  // Chunks of an in-flight mod upload are not server state and can be large.
  assert.ok(EXCLUDED_FROM_BACKUP.includes('.tmp_uploads'), 'partial uploads must be excluded');
});

test('archiving produces a readable, non-empty zip of the right entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const target = path.join(os.tmpdir(), `archive-test-${Date.now()}.zip`);

  fs.mkdirSync(path.join(dir, 'worlds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worlds', 'modtest.wld'), 'world bytes');
  fs.writeFileSync(path.join(dir, 'serverconfig.txt'), 'worldname=modtest');

  try {
    // Whichever archiver is available: zip, 7z, or the in-process fallback. The point is
    // that the result is usable, not which tool made it.
    await archiveDirectory(dir, target, ['worlds', 'serverconfig.txt']);

    const stats = fs.statSync(target);
    assert.ok(stats.size > 0, 'a zero-byte archive is the failure this guards against');

    // Entry separators vary by archiver and platform; normalise before asserting on paths.
    const names = new AdmZip(target).getEntries().map((e) => e.entryName.split('\\').join('/'));
    assert.ok(names.some((n) => n.endsWith('serverconfig.txt')), 'top-level files are included');
    assert.ok(names.some((n) => n.includes('worlds/') && n.endsWith('.wld')), 'nested files keep their path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
  }
});

test('archiving a path that does not exist fails loudly and leaves nothing behind', async () => {
  // A half-written archive left on disk would sort newest and be offered by a restore.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const target = path.join(os.tmpdir(), `archive-missing-${Date.now()}.zip`);

  try {
    await assert.rejects(() => archiveDirectory(dir, target, ['does-not-exist']));
    assert.equal(fs.existsSync(target), false, 'no partial archive is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
  }
});
