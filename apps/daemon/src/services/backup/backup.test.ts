import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Game } from '@mc-manager/shared';
import { gameOfServerDir } from './backup';

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
