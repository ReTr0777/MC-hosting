import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  GAME_CAPABILITIES,
  DEFAULT_TERRARIA_CONFIG,
  TERRARIA_MAX_PLAYERS,
  TERRARIA_SECRET_SEEDS,
  terrariaSupportsMods,
  TERRARIA_WORLD_EVILS,
  parseTerrariaConfig,
} from './index';

/*
 * parseTerrariaConfig always returns a complete config rather than reporting which
 * field was wrong. That is the point: an incomplete serverconfig.txt leaves Terraria
 * sitting at an interactive world-selection prompt forever, emitting no newline, so
 * there is nothing downstream to detect the failure from (plan.md §6, Finding 3).
 */

test('an empty or absent config still produces a bootable one', () => {
  assert.deepEqual(parseTerrariaConfig(undefined), DEFAULT_TERRARIA_CONFIG);
  assert.deepEqual(parseTerrariaConfig(null), DEFAULT_TERRARIA_CONFIG);
  assert.deepEqual(parseTerrariaConfig({}), DEFAULT_TERRARIA_CONFIG);
  assert.deepEqual(parseTerrariaConfig('nonsense'), DEFAULT_TERRARIA_CONFIG);
});

test('out-of-range world size and difficulty fall back instead of reaching the config file', () => {
  const parsed = parseTerrariaConfig({ autocreate: 9, difficulty: -1 });
  assert.equal(parsed.autocreate, DEFAULT_TERRARIA_CONFIG.autocreate);
  assert.equal(parsed.difficulty, DEFAULT_TERRARIA_CONFIG.difficulty);
});

test('valid values are kept, including the falsy ones', () => {
  // difficulty 0 is classic mode, not "unset" — a truthiness check here would
  // silently upgrade every classic world to whatever the default is.
  const parsed = parseTerrariaConfig({ autocreate: 3, difficulty: 0, maxPlayers: 16 });
  assert.equal(parsed.autocreate, 3);
  assert.equal(parsed.difficulty, 0);
  assert.equal(parsed.maxPlayers, 16);
});

test('maxPlayers is clamped to what the server will actually accept', () => {
  assert.equal(parseTerrariaConfig({ maxPlayers: 9999 }).maxPlayers, TERRARIA_MAX_PLAYERS);
  assert.equal(parseTerrariaConfig({ maxPlayers: 0 }).maxPlayers, DEFAULT_TERRARIA_CONFIG.maxPlayers);
  assert.equal(parseTerrariaConfig({ maxPlayers: 4.7 }).maxPlayers, 4);
});

test('a blank world name never reaches the config file', () => {
  assert.equal(parseTerrariaConfig({ worldName: '   ' }).worldName, DEFAULT_TERRARIA_CONFIG.worldName);
  assert.equal(parseTerrariaConfig({ worldName: ' Hallow ' }).worldName, 'Hallow');
});

test('an unknown variant is treated as vanilla, since that is the only one v1 ships', () => {
  assert.equal(parseTerrariaConfig({ variant: 'CALAMITY' }).variant, 'VANILLA');
  assert.equal(parseTerrariaConfig({ variant: 'TSHOCK' }).variant, 'TSHOCK');
});

test('an empty password is omitted rather than written as a blank one', () => {
  // `password=` in serverconfig.txt is not the same as no password line at all.
  assert.equal('password' in parseTerrariaConfig({ password: '' }), false);
  assert.equal(parseTerrariaConfig({ password: 'hunter2' }).password, 'hunter2');
});

test('a seed is kept verbatim, and blank means "roll a random one"', () => {
  // Terraria treats the seed as free text — its magic phrases are seeds too — so it
  // must not be normalised beyond trimming.
  assert.equal(parseTerrariaConfig({ seed: 'for the worthy' }).seed, 'for the worthy');
  assert.equal(parseTerrariaConfig({ seed: '  AwesomeSeed  ' }).seed, 'AwesomeSeed');
  assert.equal('seed' in parseTerrariaConfig({ seed: '   ' }), false);
  assert.equal('seed' in parseTerrariaConfig({}), false);
});

test('unknown secret seeds are dropped rather than written into the config', () => {
  // Each accepted id maps to a number the daemon types at Terraria's secret-seed
  // menu, so an unrecognised one would either toggle nothing or toggle the wrong row.
  const parsed = parseTerrariaConfig({ secretSeeds: ['notthebees', 'definitelyfake', 'zenith'] });
  assert.deepEqual(parsed.secretSeeds, ['notthebees', 'zenith']);
});

test('duplicate secret seeds collapse, and an empty list is omitted', () => {
  assert.deepEqual(parseTerrariaConfig({ secretSeeds: ['drunk', 'drunk'] }).secretSeeds, ['drunk']);
  assert.equal('secretSeeds' in parseTerrariaConfig({ secretSeeds: [] }), false);
  assert.equal('secretSeeds' in parseTerrariaConfig({ secretSeeds: 'notthebees' }), false);
});

test('every catalogued secret seed round-trips', () => {
  const all = TERRARIA_SECRET_SEEDS.map((s) => s.id);
  assert.deepEqual(parseTerrariaConfig({ secretSeeds: all }).secretSeeds, all);
});

test('cheat protection defaults on, and only an explicit false turns it off', () => {
  // A config written before the field existed must not silently lose the protection.
  assert.equal(parseTerrariaConfig({}).secure, true);
  assert.equal(parseTerrariaConfig({ secure: undefined }).secure, true);
  assert.equal(parseTerrariaConfig({ secure: false }).secure, false);
  assert.equal(parseTerrariaConfig({ secure: true }).secure, true);
});

test('world evil defaults to random and rejects anything unrecognised', () => {
  // Random is what every server did before the field existed, and it is the only
  // safe reading of a value we do not understand.
  assert.equal(parseTerrariaConfig({}).evil, 'RANDOM');
  assert.equal(parseTerrariaConfig({ evil: 'PURPLE' }).evil, 'RANDOM');
  assert.equal(parseTerrariaConfig({ evil: 'corruption' }).evil, 'RANDOM', 'matching is case-sensitive');
  assert.equal(parseTerrariaConfig({ evil: 'CORRUPTION' }).evil, 'CORRUPTION');
  assert.equal(parseTerrariaConfig({ evil: 'CRIMSON' }).evil, 'CRIMSON');
});

test('every world evil and secret seed carries the menu index the daemon types', () => {
  // These numbers are answers to Terraria's interactive prompts. A wrong one does
  // not error — it silently generates the wrong kind of world.
  assert.deepEqual(
    TERRARIA_WORLD_EVILS.map((e) => [e.id, e.menuIndex]),
    [['RANDOM', 1], ['CORRUPTION', 2], ['CRIMSON', 3]]
  );
  const indexes = TERRARIA_SECRET_SEEDS.map((s) => s.menuIndex);
  assert.equal(new Set(indexes).size, indexes.length, 'menu indexes must be unique');
  // 1 is "Normal" in Terraria's menu, so no secret seed may claim it.
  assert.equal(indexes.includes(1 as never), false);
});

test('every game has a capability entry, so the panel can never gate on undefined', () => {
  for (const game of Object.values(Game)) {
    assert.ok(GAME_CAPABILITIES[game], `${game} is missing a capability entry`);
  }
});

test("Minecraft's capabilities still describe everything the panel offers today", () => {
  // Nothing reads these for Minecraft — they are descriptive. The assertion exists so
  // that if Phase 4 ever starts gating Minecraft tabs on them, the values are right.
  const mc = GAME_CAPABILITIES[Game.MINECRAFT];
  // Two entries are filenames rather than switches, and are asserted separately.
  const fileFields = ['configFile', 'banFile'];
  /*
   * Capabilities that describe another game's system, where `false` for Minecraft is the
   * correct answer rather than a gap. `tmodMods` is tModLoader's `.tmod` files; Minecraft
   * has no such thing, and claiming it did would be the bug this test is meant to catch.
   */
  const notMinecraftConcepts = ['tmodMods'];
  for (const [flag, value] of Object.entries(mc)) {
    if (fileFields.includes(flag)) continue;
    if (notMinecraftConcepts.includes(flag)) {
      assert.equal(value, false, `Minecraft should not claim ${flag}`);
      continue;
    }
    assert.equal(value, true, `Minecraft should still support ${flag}`);
  }
  assert.equal(mc.configFile, 'server.properties');
  // Null on purpose: Minecraft's bans live in structured JSON with their own
  // routes, not in a flat file the line editor would rewrite.
  assert.equal(mc.banFile, null);
});

test('only tModLoader loads mods, so only it gets the mods tab', () => {
  // Vanilla ignores a Mods folder entirely. Offering the tab there would be a page where
  // every upload silently does nothing, which reads as a broken panel.
  assert.equal(GAME_CAPABILITIES[Game.TERRARIA].tmodMods, true, 'the game has a mod system');
  assert.equal(terrariaSupportsMods('TMODLOADER'), true);
  assert.equal(terrariaSupportsMods('VANILLA'), false);
  assert.equal(terrariaSupportsMods('TSHOCK'), false);
  assert.equal(terrariaSupportsMods(undefined), false, 'a config predating the field is vanilla');
});

test('Terraria keeps its ban list in a flat file, which is why the tab shows one', () => {
  const tr = GAME_CAPABILITIES[Game.TERRARIA];
  assert.equal(tr.bans, true, 'a ban list exists');
  assert.equal(tr.banFile, 'banlist.txt', 'and it is this file');
  assert.equal(tr.playerBan, true, 'and players can be banned into it');
});
