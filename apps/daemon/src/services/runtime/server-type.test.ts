import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectServerType, versionFromJarName } from './server-type';

/** Builds a throwaway server directory containing exactly the given entries. */
function dirWith(entries: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-type-'));
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (entry.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
  }
  return root;
}

test('SkyFactory 4: a 1.12.2 Forge pack is Forge, not Fabric', () => {
  /*
   * The case this was written for. Every one of these files was on screen while the panel
   * insisted the server was FABRIC LATEST, because the old check only knew about the
   * args files Forge started generating at 1.17.
   */
  const dir = dirWith([
    'forge-1.12.2-14.23.5.2860-installer.jar',
    'forge-1.12.2-14.23.5.2860-installer.jar.log',
    'ServerStart.sh',
    'ServerStart.bat',
    'settings.sh',
    'settings.bat',
    'mods/',
    'config/',
    'scripts/',
  ]);
  const detected = detectServerType(dir);
  assert.equal(detected.loader, 'FORGE');
  assert.equal(detected.version, '1.12.2');
});

test('a Forge pack that has never been started is still Forge', () => {
  // No jar yet: the FTB launcher downloads it on first boot. The scripts are all there is.
  const dir = dirWith(['ServerStart.sh', 'settings.sh', 'mods/']);
  assert.equal(detectServerType(dir).loader, 'FORGE');
});

test('Forge 1.17+ is recognised by the args files, as it always was', () => {
  assert.equal(detectServerType(dirWith(['user_args.txt', 'libraries/'])).loader, 'FORGE');
  assert.equal(detectServerType(dirWith(['unix_args.txt'])).loader, 'FORGE');
});

test('NeoForge is not swallowed by the Forge check', () => {
  // "forge" is a substring of "neoforge", and both ship unix_args.txt. Testing Forge
  // first would label every NeoForge pack as Forge and download the wrong loader.
  const dir = dirWith(['unix_args.txt', 'libraries/net/neoforged/']);
  assert.equal(detectServerType(dir).loader, 'NEOFORGE');

  const jarDir = dirWith(['neoforge-1.21.1-21.1.77-installer.jar']);
  const detected = detectServerType(jarDir);
  assert.equal(detected.loader, 'NEOFORGE');
  assert.equal(detected.version, '1.21.1');
});

test('a real Fabric server is still Fabric', () => {
  assert.equal(detectServerType(dirWith(['fabric-server-launch.jar', 'mods/'])).loader, 'FABRIC');
  assert.equal(detectServerType(dirWith(['fabric-server-launcher.properties'])).loader, 'FABRIC');
});

test('Fabric wins over a stray forge jar left in the directory', () => {
  // Packs migrated between loaders keep the old jar around. The launcher artefact is the
  // one that says what will actually boot.
  const dir = dirWith(['fabric-server-launch.jar', 'forge-1.12.2-14.23.5.2860-installer.jar']);
  assert.equal(detectServerType(dir).loader, 'FABRIC');
});

test('Quilt is told apart from Fabric', () => {
  assert.equal(detectServerType(dirWith(['quilt-server-launch.jar'])).loader, 'QUILT');
});

test('a directory with no evidence says so, rather than guessing', () => {
  // The caller falls back to Fabric and logs why. Returning FABRIC from here would make
  // "we found Fabric" and "we found nothing" indistinguishable.
  const detected = detectServerType(dirWith(['world/', 'server.properties']));
  assert.equal(detected.loader, null);
  assert.equal(detected.evidence, null);
});

test('a directory that does not exist is not a crash', () => {
  assert.equal(detectServerType(path.join(os.tmpdir(), 'definitely-not-here-9f2a')).loader, null);
});

test('the Minecraft version is taken from the jar name, not the loader build', () => {
  // 14.23.5.2860 is the Forge build. Asking itzg for Minecraft 14.23.5 would fail.
  assert.equal(versionFromJarName('forge-1.12.2-14.23.5.2860-installer.jar'), '1.12.2');
  assert.equal(versionFromJarName('forge-1.20.1-47.2.0-universal.jar'), '1.20.1');
  assert.equal(versionFromJarName('neoforge-1.21-21.0.167-installer.jar'), '1.21');
  assert.equal(versionFromJarName('server.jar'), null);
});
