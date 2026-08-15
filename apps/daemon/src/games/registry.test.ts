import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@mc-manager/shared';
import { getGame, isNonMinecraftGame, registerGame, registeredGames } from './index';
import { GameDefinition } from './types';

/*
 * The dispatch guard at the top of ProcessManager.startProcess is the single place
 * where adding a game could break Minecraft. Everything here is about one rule:
 * Minecraft must never be routed away from its own code path, no matter what the
 * DTO says — including DTOs written before the `game` field existed.
 */

test('an absent game means Minecraft, so pre-Phase-2 DTOs keep their old path', () => {
  // craftcontrol-meta.json files written before this field simply have no `game`.
  assert.equal(isNonMinecraftGame(undefined), false);
  assert.equal(getGame(undefined), undefined);
});

test('an explicit MINECRAFT never dispatches', () => {
  assert.equal(isNonMinecraftGame(Game.MINECRAFT), false);
  assert.equal(getGame(Game.MINECRAFT), undefined);
});

test('junk and empty strings fall through to Minecraft rather than dispatching', () => {
  // A corrupted meta.json must degrade to "start it the way we always did",
  // not to "start it as some other game".
  for (const value of ['', 'minecraft', 'QUAKE', 'TERRARIA_', ' TERRARIA']) {
    assert.equal(isNonMinecraftGame(value), false, `${JSON.stringify(value)} should not dispatch`);
  }
});

test('a known non-Minecraft game dispatches', () => {
  assert.equal(isNonMinecraftGame(Game.TERRARIA), true);
});

test('Terraria is registered and resolves to a usable module', () => {
  assert.equal(registeredGames().includes(Game.TERRARIA), true);
  const def = getGame(Game.TERRARIA);
  assert.ok(def, 'Terraria should resolve');
  assert.equal(def!.stopCommand, 'exit', 'Minecraft says `stop`; Terraria says `exit`');
});

test('a game with no module resolves to undefined rather than something Minecraft-shaped', () => {
  // startGameProcess keys off exactly this to fail loudly instead of falling
  // through to the Minecraft spawn.
  assert.equal(getGame('SATISFACTORY'), undefined);
});

test('a populated registry still cannot capture Minecraft', () => {
  const fake = { id: Game.TERRARIA, label: 'Fake', stopCommand: 'nope' } as GameDefinition;
  registerGame(fake);

  assert.equal(getGame(Game.TERRARIA), fake, 'registration is last-write-wins');
  // The important half: Minecraft is unreachable through the registry no matter
  // what is in it.
  assert.equal(getGame(Game.MINECRAFT), undefined);
  assert.equal(getGame(undefined), undefined);
});
