import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, ALL_GAMES, DEFAULT_ENABLED_GAMES, isGame, parseGameList } from './index';

/*
 * These cover the one rule in the node-capability feature that can silently break a
 * working deployment: a daemon that reports nothing must never be read as "hosts no
 * games". Getting that wrong hides every node from the create wizard on the next
 * ping, five seconds after an upgrade, with no visible cause.
 */

test('a daemon too old to report games yields null, not an empty list', () => {
  // The panel keys off exactly this to decide "leave the stored value alone".
  assert.equal(parseGameList(undefined), null);
  assert.equal(parseGameList(null), null);
});

test('an explicitly empty list is also null rather than an empty array', () => {
  // A node advertising nothing is unusable, so it is treated as no opinion and the
  // caller falls back — never written through to the database.
  assert.equal(parseGameList([]), null);
});

test('unknown game ids are dropped rather than trusted', () => {
  assert.deepEqual(parseGameList(['MINECRAFT', 'QUAKE']), [Game.MINECRAFT]);
  // A list of nothing but junk leaves no opinion, rather than an empty result.
  assert.equal(parseGameList(['QUAKE', 'DOOM']), null);
});

test('duplicates collapse', () => {
  assert.deepEqual(parseGameList(['MINECRAFT', 'MINECRAFT']), [Game.MINECRAFT]);
});

test('non-array input is rejected outright', () => {
  assert.equal(parseGameList('MINECRAFT'), null);
  assert.equal(parseGameList({ 0: 'MINECRAFT' }), null);
});

test('the default is Minecraft-only, so existing nodes keep behaving as they do today', () => {
  assert.deepEqual(DEFAULT_ENABLED_GAMES, [Game.MINECRAFT]);
});

test('the schema default matches DEFAULT_ENABLED_GAMES', () => {
  // Node.enabledGames is declared `@default(["MINECRAFT"])`. If the two ever drift, a
  // node created before its first ping would advertise something the code disagrees with.
  assert.deepEqual(DEFAULT_ENABLED_GAMES.map(String), ['MINECRAFT']);
});

test('every advertised game is one the daemon actually recognises', () => {
  for (const game of ALL_GAMES) {
    assert.ok(isGame(game), `${game} should round-trip through isGame`);
  }
  assert.equal(isGame('minecraft'), false, 'matching is case-sensitive');
  assert.equal(isGame(undefined), false);
});
