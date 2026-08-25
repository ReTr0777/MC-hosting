import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getItzgImageTag } from './docker';

/*
 * Which JVM a server gets is decided entirely by this function, because the image tag
 * carries the JDK. Getting it wrong is not a warning — a 1.12.2 Forge pack on Java 17
 * dies inside LaunchWrapper, and the stack trace names neither Java nor the version.
 */

test('old versions get Java 8, which is the only JVM old Forge runs on', () => {
  for (const v of ['1.12.2', '1.7.10', '1.8.9', '1.16.5']) {
    assert.equal(getItzgImageTag(v), 'itzg/minecraft-server:java8', v);
  }
});

test('the 1.17 to 1.20.4 range gets Java 17', () => {
  for (const v of ['1.17.1', '1.18.2', '1.20.1', '1.20.4']) {
    assert.equal(getItzgImageTag(v), 'itzg/minecraft-server:java17', v);
  }
});

test('1.20.5 is where Java 21 starts, mid-minor', () => {
  // The boundary is a patch release, not a minor one — 1.20.4 and 1.20.6 need different
  // JDKs, which is the kind of thing a range check gets wrong.
  assert.equal(getItzgImageTag('1.20.4'), 'itzg/minecraft-server:java17');
  assert.equal(getItzgImageTag('1.20.5'), 'itzg/minecraft-server:java21');
  assert.equal(getItzgImageTag('1.21.4'), 'itzg/minecraft-server:java21');
});

test('the newest versions get Java 25', () => {
  assert.equal(getItzgImageTag('26.2'), 'itzg/minecraft-server:java25');
  assert.equal(getItzgImageTag('1.26'), 'itzg/minecraft-server:java25');
});

test('LATEST means the latest image, not the oldest JDK', () => {
  /*
   * The trap behind the SkyFactory failure: a server whose version is left at LATEST
   * gets a current JVM. That is right for a vanilla server and fatal for a 1.12.2
   * modpack, so the version has to be set explicitly for old packs — there is nothing
   * in the word LATEST for this function to work with.
   */
  assert.equal(getItzgImageTag('LATEST'), 'itzg/minecraft-server:latest');
  assert.equal(getItzgImageTag(undefined), 'itzg/minecraft-server:latest');
});
