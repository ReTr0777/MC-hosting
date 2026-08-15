import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRARIA_VERSION,
  terrariaDownloadUrl,
  isTerrariaReadyLine,
  isTerrariaNoiseLine,
  parseTerrariaPresenceLine,
} from './terraria';

/*
 * These lock down the four findings from the spike (plan.md §6). Every sample
 * line below was copied from real captured output, not invented — the failure
 * modes here are silent ones: a ready line that never matches looks exactly
 * like a hung server, and a noise filter that misses looks like a working
 * console right up until the buffer is full of world generation.
 */

test('the ready line matches whether or not the prompt is glued to it', () => {
  // 1.4.5.6 emitted it bare; 1.4.4.9 emitted it prefixed. Both are real.
  assert.equal(isTerrariaReadyLine('Server started'), true);
  assert.equal(isTerrariaReadyLine(': Server started'), true);
  assert.equal(isTerrariaReadyLine(':Server started'), true);
});

test('lines that merely mention the server are not readiness', () => {
  assert.equal(isTerrariaReadyLine('Terraria Server v1.4.5.6'), false);
  assert.equal(isTerrariaReadyLine('Listening on port 7777'), false);
  assert.equal(isTerrariaReadyLine("Type 'help' for a list of commands."), false);
});

test('world generation progress is dropped, in both shapes it comes in', () => {
  // The dominant shape: 30,675 of these in ~14s on a *small* world.
  assert.equal(isTerrariaNoiseLine('60.3% - Smoothing the world - 0.0%'), true);
  assert.equal(isTerrariaNoiseLine('0.0% - Generating world terrain - 0.3%'), true);
  assert.equal(isTerrariaNoiseLine('84.3% - Growing long moss - 0.4%'), true);
  // The shape the two-percent pattern misses, found at 1.4.5.6.
  assert.equal(isTerrariaNoiseLine('Resetting game objects 96%'), true);
  assert.equal(isTerrariaNoiseLine('Validating world save: 24%'), true);
});

test('the bare prompt is noise, however many of them arrive at once', () => {
  // Otherwise it is the single most common line in the console. `": : "` is not
  // hypothetical — it reached a live console before the matcher allowed repeats,
  // because two commands completed inside one stdout chunk.
  assert.equal(isTerrariaNoiseLine(': '), true);
  assert.equal(isTerrariaNoiseLine(':'), true);
  assert.equal(isTerrariaNoiseLine(': : '), true);
  assert.equal(isTerrariaNoiseLine(':::'), true);
  assert.equal(isTerrariaNoiseLine('   '), true);
});

test('a repeated prompt still does not hide a real line behind it', () => {
  assert.equal(isTerrariaReadyLine(': : Server started'), true);
  assert.deepEqual(
    parseTerrariaPresenceLine(': : Steve has joined.'),
    { type: 'join', username: 'Steve' }
  );
});

test('real console output is never mistaken for noise', () => {
  for (const line of [
    'Server started',
    'Listening on port 7777',
    'Terraria Server v1.4.5.6',
    'Saving before exit...',
    'No players connected.',
    'Steve has joined.',
    ': Steve has joined.',
  ]) {
    assert.equal(isTerrariaNoiseLine(line), false, `${JSON.stringify(line)} should reach the console`);
  }
});

test('join and leave are parsed, prompt prefix or not', () => {
  assert.deepEqual(parseTerrariaPresenceLine('Steve has joined.'), { type: 'join', username: 'Steve' });
  assert.deepEqual(parseTerrariaPresenceLine(': Steve has joined.'), { type: 'join', username: 'Steve' });
  assert.deepEqual(parseTerrariaPresenceLine('Steve has left.'), { type: 'leave', username: 'Steve' });
});

test('a kick counts as a leave, so the player list does not strand the kicked player', () => {
  assert.deepEqual(
    parseTerrariaPresenceLine('Steve was booted: Cheating detected.'),
    { type: 'leave', username: 'Steve' }
  );
});

test('names with spaces survive — Terraria has no username charset rule', () => {
  // There is no UUID analogue either; the name is all the presence data there is.
  assert.deepEqual(
    parseTerrariaPresenceLine('Some Player Name has joined.'),
    { type: 'join', username: 'Some Player Name' }
  );
});

test('ordinary lines produce no presence event', () => {
  for (const line of ['Server started', 'No players connected.', '60.3% - Smoothing the world - 0.0%', ': ']) {
    assert.equal(parseTerrariaPresenceLine(line), null, `${JSON.stringify(line)} is not presence`);
  }
});

test('the download url strips dots, and the pin is a real version', () => {
  assert.equal(
    terrariaDownloadUrl('1.4.5.6'),
    'https://terraria.org/api/download/pc-dedicated-server/terraria-server-1456.zip'
  );
  // Guards against a bump to a version shaped wrong; 1456 is the one the spike verified.
  assert.match(TERRARIA_VERSION, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(terrariaDownloadUrl(TERRARIA_VERSION).endsWith('1456.zip'), true);
});
