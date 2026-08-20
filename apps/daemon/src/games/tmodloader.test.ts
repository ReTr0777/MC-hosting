import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  TMODLOADER_VERSION,
  tmodloaderDownloadUrl,
  readModInternalName,
  readEnabledMods,
  writeEnabledMods,
  buildTmodloaderLaunch,
  modsDir,
  enabledJsonPath,
} from './tmodloader';

/*
 * The failure modes here are all silent ones.
 *
 * A mod enabled under the wrong name is present in the folder, listed in enabled.json,
 * and simply never loads — the server starts perfectly and the mod is not there. A launch
 * missing -modpath loads some *other* server's mods. Neither produces an error message,
 * so neither would be noticed without these.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmod-test-'));
}

/** A .NET BinaryWriter string: 7-bit encoded length, then UTF-8 bytes. */
function dotNetString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const lengthBytes: number[] = [];
  let len = body.length;
  do {
    let byte = len & 0x7f;
    len >>>= 7;
    if (len !== 0) byte |= 0x80;
    lengthBytes.push(byte);
  } while (len !== 0);
  return Buffer.concat([Buffer.from(lengthBytes), body]);
}

/** A minimal but structurally real .tmod header. */
function fakeTmod(modName: string, tmlVersion = '2026.06.3.6'): Buffer {
  return Buffer.concat([
    Buffer.from('TMOD', 'ascii'),
    dotNetString(tmlVersion),
    Buffer.alloc(20), // hash
    Buffer.alloc(256), // signature
    Buffer.alloc(4), // data length
    dotNetString(modName),
    dotNetString('1.0.0'),
  ]);
}

test('the download url points at the GitHub release asset', () => {
  assert.equal(
    tmodloaderDownloadUrl('2026.06.3.6'),
    'https://github.com/tModLoader/tModLoader/releases/download/v2026.06.3.6/tModLoader.zip'
  );
  // The pin is date-based, not a Terraria version. Catching a value like "1.4.4" here is
  // the difference between a clear error and a 404 during someone's first start.
  assert.match(TMODLOADER_VERSION, /^\d{4}\.\d{2}\.\d+(\.\d+)?$/);
});

test('the internal name comes from the header, not the filename', () => {
  // This is the whole point: mods ship as "Calamity Mod v2.0.tmod" and call themselves
  // "CalamityMod". Enabling the filename produces a mod that never loads.
  const dir = tmpDir();
  const file = path.join(dir, 'Calamity Mod v2.0.tmod');
  fs.writeFileSync(file, fakeTmod('CalamityMod'));

  assert.equal(readModInternalName(file), 'CalamityMod');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a long mod name still parses, so the multi-byte length prefix is right', () => {
  // Names under 128 bytes take a one-byte prefix and would pass even with the
  // continuation bit mishandled. This one does not.
  const dir = tmpDir();
  const longName = 'A'.repeat(300);
  const file = path.join(dir, 'long.tmod');
  fs.writeFileSync(file, fakeTmod(longName));

  assert.equal(readModInternalName(file), longName);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('anything that is not a .tmod reads as null rather than throwing', () => {
  // One malformed upload must not break the whole mod list.
  const dir = tmpDir();

  const notTmod = path.join(dir, 'renamed.tmod');
  fs.writeFileSync(notTmod, Buffer.from('PK\x03\x04 this is a zip', 'binary'));
  assert.equal(readModInternalName(notTmod), null);

  const truncated = path.join(dir, 'truncated.tmod');
  fs.writeFileSync(truncated, fakeTmod('SomeMod').subarray(0, 30));
  assert.equal(readModInternalName(truncated), null);

  assert.equal(readModInternalName(path.join(dir, 'absent.tmod')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enabled.json survives a round trip, and a missing one means nothing is enabled', () => {
  const dir = tmpDir();

  // Missing file must not throw: it is the state every new server starts in.
  assert.deepEqual(readEnabledMods(dir), []);

  writeEnabledMods(dir, ['CalamityMod', 'ThoriumMod']);
  assert.deepEqual(readEnabledMods(dir), ['CalamityMod', 'ThoriumMod']);
  assert.equal(fs.existsSync(enabledJsonPath(dir)), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate names are collapsed, so enabling twice cannot corrupt the list', () => {
  const dir = tmpDir();
  writeEnabledMods(dir, ['ModB', 'ModA', 'ModB']);
  assert.deepEqual(readEnabledMods(dir), ['ModA', 'ModB']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt enabled.json reads as empty rather than failing the start', () => {
  const dir = tmpDir();
  fs.mkdirSync(modsDir(dir), { recursive: true });
  fs.writeFileSync(enabledJsonPath(dir), '{ not json');
  assert.deepEqual(readEnabledMods(dir), []);

  // An object where an array belongs is the likelier hand-edit mistake.
  fs.writeFileSync(enabledJsonPath(dir), '{"CalamityMod": true}');
  assert.deepEqual(readEnabledMods(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the launch keeps worlds and mods inside the server directory', () => {
  /*
   * Without -tmlsavedirectory and -modpath, tModLoader uses a per-user path shared by
   * every server on the node: two servers would overwrite each other's saves and load
   * each other's mods, and a restored backup would start with the wrong world.
   */
  const serverDir = '/data/servers/abc123';
  const launch = buildTmodloaderLaunch(
    serverDir,
    '/cache/tmodloader/2026.06.3.6/LaunchUtils/ScriptCaller.sh',
    '/data/servers/abc123/serverconfig.txt'
  );

  assert.equal(launch.command, '/cache/tmodloader/2026.06.3.6/LaunchUtils/ScriptCaller.sh');
  assert.ok(launch.args.includes('-server'), 'must run as a server, not a client');

  const savedir = launch.args[launch.args.indexOf('-tmlsavedirectory') + 1];
  assert.equal(savedir, serverDir);

  const modpath = launch.args[launch.args.indexOf('-modpath') + 1];
  assert.equal(modpath, modsDir(serverDir));

  // HOME points at the build root so the .NET runtime the launcher downloads lands in the
  // daemon's data directory, not in root's home where no backup would ever cover it.
  assert.equal(launch.env?.HOME, '/cache/tmodloader/2026.06.3.6');
});
