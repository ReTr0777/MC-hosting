import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exactVersionPin, packRequirements } from './pack-requirements';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pack-req-'));

/** Writes a jar containing one metadata file, the way a real mod ships it. */
function modJar(dir: string, name: string, entry: string, body: string): void {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile(entry, Buffer.from(body, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  zip.writeZip(path.join(dir, name));
}

function fabricMod(dir: string, name: string, doc: Record<string, unknown>): void {
  modJar(dir, name, 'fabric.mod.json', JSON.stringify(doc));
}

test('an exact pin is read; a range is not mistaken for one', () => {
  /*
   * Only unambiguous pins count. ">=1.20 <1.20.2-" names two versions and means neither
   * specifically — counting it would let a mod supporting six versions outvote the one
   * mod that supports a single version, and the narrow one decides what can actually run.
   */
  assert.equal(exactVersionPin('1.20.1'), '1.20.1');
  assert.equal(exactVersionPin('[1.12.2]'), '1.12.2');
  assert.equal(exactVersionPin('=1.19'), '1.19');

  // Verbatim from Fabric API's own fabric.mod.json.
  assert.equal(exactVersionPin('>=1.20 <1.20.2-'), null);
  assert.equal(exactVersionPin('[1.20.1,)'), null);
  assert.equal(exactVersionPin('*'), null);
});

test('the version the pack pins is found, and outvotes a single dissenter', () => {
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  fabricMod(mods, 'a.jar', { id: 'a', depends: { minecraft: '1.20.1' } });
  fabricMod(mods, 'b.jar', { id: 'b', depends: { minecraft: '1.20.1' } });
  fabricMod(mods, 'c.jar', { id: 'c', depends: { minecraft: '1.19.2' } });
  // A range contributes nothing either way.
  fabricMod(mods, 'd.jar', { id: 'd', depends: { minecraft: '>=1.18 <1.21' } });

  const req = packRequirements(dir);
  assert.equal(req.minecraftVersion, '1.20.1');
  assert.equal(req.pinnedBy, 2);
  assert.equal(req.modsScanned, 4);
});

test('the StarT case: mods pinning 1.20.1 while the server resolved to 26.2', () => {
  // Exactly what the loader reported after the fact — FTB Quests Freeze Fix requires
  // [1.20.1], and Minecraft 26.2 was present instead.
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  fabricMod(mods, 'ftbquestsfreezefix.jar', {
    id: 'ftbquestsfreezefix',
    depends: { minecraft: '1.20.1', 'fabric-api': '*' },
  });

  const req = packRequirements(dir);
  assert.equal(req.minecraftVersion, '1.20.1');
  assert.ok(req.fabricApiMissing, 'nothing here provides the Fabric API');
});

test('Fabric API present is recognised through provides, not only its id', () => {
  // fabric-api declares provides: ["fabric"], and mods depend on either name.
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  fabricMod(mods, 'needs-api.jar', { id: 'needs', depends: { minecraft: '1.20.1', fabric: '*' } });
  fabricMod(mods, 'fabric-api.jar', { id: 'fabric-api', provides: ['fabric'], depends: { minecraft: '>=1.20' } });

  assert.equal(packRequirements(dir).fabricApiMissing, false);
});

test('a Forge mods.toml version range is read too', () => {
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  modJar(
    mods,
    'forge-mod.jar',
    'META-INF/mods.toml',
    `modLoader="javafml"\n[[mods]]\nmodId="thing"\n[[dependencies.thing]]\n  modId="minecraft"\n  mandatory=true\n  versionRange="[1.12.2]"\n  ordering="NONE"\n`
  );

  const req = packRequirements(dir);
  assert.equal(req.minecraftVersion, '1.12.2');
  // Forge mods never want the Fabric API, whatever else they need.
  assert.equal(req.fabricApiMissing, false);
});

test('a directory with no mods says nothing rather than guessing', () => {
  const req = packRequirements(tmp());
  assert.equal(req.minecraftVersion, null);
  assert.equal(req.modsScanned, 0);
  assert.equal(req.fabricApiMissing, false);
});

test('an unreadable jar is skipped, not fatal', () => {
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(mods, 'broken.jar'), 'not a zip');
  fabricMod(mods, 'good.jar', { id: 'good', depends: { minecraft: '1.20.1' } });

  const req = packRequirements(dir);
  assert.equal(req.minecraftVersion, '1.20.1');
  assert.equal(req.modsScanned, 1, 'the broken jar should not be counted as scanned');
});

test('a real Fabric API jar parses, and its own range is not read as a pin', async (t) => {
  /*
   * Against the artefact Modrinth actually serves. The synthetic jars above prove the
   * logic; this proves the shape of the file has not moved under it.
   */
  let versions: any;
  try {
    const res = await fetch(
      'https://api.modrinth.com/v2/project/fabric-api/version?game_versions=%5B%221.20.1%22%5D&loaders=%5B%22fabric%22%5D',
      { signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) return t.skip('no network');
    versions = await res.json();
  } catch {
    return t.skip('no network');
  }
  if (!versions?.length) return t.skip('no versions returned');

  const file = versions[0].files.find((f: any) => f.primary) || versions[0].files[0];
  const dir = tmp();
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  try {
    const jar = await fetch(file.url, { signal: AbortSignal.timeout(60000) });
    fs.writeFileSync(path.join(mods, 'fabric-api.jar'), Buffer.from(await jar.arrayBuffer()));
  } catch {
    return t.skip('could not fetch the jar');
  }

  const req = packRequirements(dir);
  assert.equal(req.modsScanned, 1, 'the real fabric.mod.json was not read');
  // Its own minecraft dependency is a range, so it pins nothing.
  assert.equal(req.minecraftVersion, null);
  // And it provides the API, so nothing is missing.
  assert.equal(req.fabricApiMissing, false);
});
