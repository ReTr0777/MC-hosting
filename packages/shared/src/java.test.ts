import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredJavaMajor, javaSupportViolation } from './java';
import { Game } from './enums';

/**
 * The case this exists for: a server on Minecraft 26.2 being migrated onto a phone
 * whose newest JDK is 21. The transfer would succeed, the source copy would then be
 * deleted, and every start afterwards would fail.
 */

test('the versions that need Java 25', () => {
  for (const v of ['26.2', '26.1', '25.0', '1.22']) {
    assert.equal(requiredJavaMajor(v), 25, v);
  }
});

test('1.21 and later need Java 21, older needs 17', () => {
  assert.equal(requiredJavaMajor('1.21.4'), 21);
  assert.equal(requiredJavaMajor('1.20.1'), 17);
});

test('a destination that cannot run the version is refused, with the numbers', () => {
  const problem = javaSupportViolation('s10samsung', Game.MINECRAFT, '26.2', 21);

  assert.ok(problem);
  assert.match(problem, /s10samsung/);
  assert.match(problem, /has Java 21/);
  assert.match(problem, /needs Java 25/);
  // Whoever reads this can install a JDK or pick another node; say so rather than
  // leaving them with a refusal and no move to make.
  assert.match(problem, /Install Java 25/);
});

test('a destination new enough is allowed', () => {
  assert.equal(javaSupportViolation('unraid', Game.MINECRAFT, '26.2', 25), null);
  assert.equal(javaSupportViolation('unraid', Game.MINECRAFT, '1.20.1', 21), null);
});

test('a node that did not report its Java is not blocked', () => {
  // An older daemon omits the field entirely. Refusing every migration to every node
  // that has not been updated would break a working feature to prevent a message.
  assert.equal(javaSupportViolation('old-node', Game.MINECRAFT, '26.2', undefined), null);
  assert.equal(javaSupportViolation('old-node', Game.MINECRAFT, '26.2', null), null);
});

test('Terraria is not judged on Java at all', () => {
  // Its version numbers parse as Minecraft-ish, so without the game check a Terraria
  // server would acquire a Java 17 requirement it does not have.
  assert.equal(javaSupportViolation('phone', Game.TERRARIA, '1.4.4.9', 8), null);
  // The same numbers under MINECRAFT do produce one, which is what makes the check matter.
  assert.ok(javaSupportViolation('phone', Game.MINECRAFT, '1.4.4.9', 8));
});
