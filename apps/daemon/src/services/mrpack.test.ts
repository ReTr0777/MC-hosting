import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  cascadeOrphanedDependents,
  quarantineClientOnlyMods,
  jarDeclaresClientOnly,
  analyzeInstalledMods,
  readPackHealth,
} from './mrpack';
import { DENYLIST_PATH_SUBSTRINGS } from './modrinth';

/**
 * Quarantining a client-only mod can strand a server-safe mod that hard-depends on it, and
 * Fabric responds by aborting the entire boot (HARD_DEP_NO_CANDIDATE) rather than skipping the
 * orphan. Real case: Better MC installs Cull Less Leaves, which declares `environment: "*"` and
 * so survives every client-only check, but needs Sodium — a mod that is correctly removed.
 */

function makeModsDir(mods: Array<{ jar: string; meta: Record<string, unknown> }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-test-'));
  for (const { jar, meta } of mods) {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta)));
    zip.writeZip(path.join(dir, jar));
  }
  return dir;
}

test('a mod left without its client-only dependency is quarantined too', () => {
  const dir = makeModsDir([
    { jar: 'sodium.jar', meta: { id: 'sodium', environment: 'client' } },
    { jar: 'cull-less-leaves.jar', meta: { id: 'cullleaves', environment: '*', depends: { sodium: '<0.6' } } },
    { jar: 'unrelated.jar', meta: { id: 'unrelated', environment: '*', depends: { minecraft: '1.20.1' } } },
  ]);

  const jars = ['sodium.jar', 'cull-less-leaves.jar', 'unrelated.jar'];
  const clientOnly = new Set(['sodium.jar']);

  const orphaned = cascadeOrphanedDependents(dir, jars, clientOnly);

  assert.ok(clientOnly.has('cull-less-leaves.jar'), 'the orphaned dependent must be quarantined');
  assert.ok(!clientOnly.has('unrelated.jar'), 'mods with satisfied dependencies must be left alone');
  assert.equal(orphaned.length, 1);
  assert.deepEqual(orphaned[0], { fileName: 'cull-less-leaves.jar', missing: 'sodium' });
});

test('orphaning cascades through chains of dependents', () => {
  const dir = makeModsDir([
    { jar: 'iris.jar', meta: { id: 'iris', environment: 'client' } },
    { jar: 'mid.jar', meta: { id: 'mid', environment: '*', depends: { iris: '*' } } },
    { jar: 'top.jar', meta: { id: 'top', environment: '*', depends: { mid: '*' } } },
  ]);

  const clientOnly = new Set(['iris.jar']);
  cascadeOrphanedDependents(dir, ['iris.jar', 'mid.jar', 'top.jar'], clientOnly);

  assert.ok(clientOnly.has('mid.jar'));
  assert.ok(clientOnly.has('top.jar'), 'a dependent of a dependent must follow it out');
});

test('a dependency satisfied through `provides` is not treated as missing', () => {
  const dir = makeModsDir([
    { jar: 'sodium.jar', meta: { id: 'sodium', environment: 'client' } },
    { jar: 'embeddium.jar', meta: { id: 'embeddium', provides: ['sodium'], environment: '*' } },
    { jar: 'dependent.jar', meta: { id: 'dependent', environment: '*', depends: { sodium: '*' } } },
  ]);

  // Only the real sodium jar is client-only; embeddium still provides that id server-side.
  const clientOnly = new Set(['sodium.jar']);
  const orphaned = cascadeOrphanedDependents(dir, ['sodium.jar', 'embeddium.jar', 'dependent.jar'], clientOnly);

  assert.equal(orphaned.length, 0);
  assert.ok(!clientOnly.has('dependent.jar'), 'the id is still supplied, so nothing is orphaned');
  assert.ok(!clientOnly.has('embeddium.jar'));
});

/**
 * Mod Menu is filtered by the download denylist, so it never reaches mods/ and this build never
 * "removed" it. Forge Config Screens hard-depends on it and crashed the boot anyway — the reason
 * resolution has to run against the ids present rather than the ids we took out.
 */
test('a dependency that was never downloaded still orphans its dependants', () => {
  const dir = makeModsDir([
    { jar: 'forgeconfigscreens.jar', meta: { id: 'forgeconfigscreens', environment: '*', depends: { modmenu: '*' } } },
    { jar: 'fine.jar', meta: { id: 'fine', environment: '*' } },
  ]);

  const clientOnly = new Set<string>();
  const orphaned = cascadeOrphanedDependents(dir, ['forgeconfigscreens.jar', 'fine.jar'], clientOnly);

  assert.ok(clientOnly.has('forgeconfigscreens.jar'));
  assert.ok(!clientOnly.has('fine.jar'));
  assert.deepEqual(orphaned[0], { fileName: 'forgeconfigscreens.jar', missing: 'modmenu' });
});

test('game and loader ids never count as missing dependencies', () => {
  const dir = makeModsDir([
    { jar: 'normal.jar', meta: { id: 'normal', environment: '*', depends: { minecraft: '1.20.1', java: '>=17', fabricloader: '>=0.15' } } },
  ]);

  const clientOnly = new Set<string>();
  const orphaned = cascadeOrphanedDependents(dir, ['normal.jar'], clientOnly);

  assert.equal(orphaned.length, 0, 'depending on minecraft/java/fabricloader is always satisfiable');
  assert.equal(clientOnly.size, 0);
});

/** Fabric API ships its modules as nested jars; dependants name the module, not `fabric-api`. */
test('ids provided by nested jars satisfy dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-nested-'));

  const moduleJar = new AdmZip();
  moduleJar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'fabric-item-api-v1' })));

  const fabricApi = new AdmZip();
  fabricApi.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'fabric-api', environment: '*' })));
  fabricApi.addFile('META-INF/jars/fabric-item-api-v1.jar', moduleJar.toBuffer());
  fabricApi.writeZip(path.join(dir, 'fabric-api.jar'));

  const dependant = new AdmZip();
  dependant.addFile(
    'fabric.mod.json',
    Buffer.from(JSON.stringify({ id: 'dependant', environment: '*', depends: { 'fabric-item-api-v1': '*' } }))
  );
  dependant.writeZip(path.join(dir, 'dependant.jar'));

  const clientOnly = new Set<string>();
  const orphaned = cascadeOrphanedDependents(dir, ['fabric-api.jar', 'dependant.jar'], clientOnly);

  assert.equal(orphaned.length, 0, 'the nested module id must resolve');
  assert.ok(!clientOnly.has('dependant.jar'));
});

/**
 * Missing Mods Checker declares `environment: "*"`, so every metadata-driven check clears it —
 * then it opens a Swing window during load and kills the server with HeadlessException. It
 * arrives via overrides/mods/, which the manifest download filter never sees, so the denylist
 * has to be reapplied to the jars on disk and must outrank what they claim about themselves.
 */
test('denylisted jars are quarantined despite declaring themselves server-safe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-deny-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  for (const [jar, meta] of [
    ['missingmodschecker.jar', { id: 'missingmodschecker', environment: '*' }],
    ['keepme.jar', { id: 'keepme', environment: '*' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta)));
    zip.writeZip(path.join(modsDir, jar));
  }

  const result = await quarantineClientOnlyMods('test-server', dir);

  assert.ok(result.moved.includes('missingmodschecker.jar'));
  assert.ok(!result.moved.includes('keepme.jar'));
  assert.ok(!fs.existsSync(path.join(modsDir, 'missingmodschecker.jar')), 'it must leave mods/');
});

test('the shared denylist covers the mods that previously crashed a boot', () => {
  // Regression guard for the duplicated-list drift: these were excluded on the container path
  // but not the mrpack path, and each one took a real server down.
  for (const slug of ['missingmodschecker', 'forgeconfigscreens', 'modmenu', 'sodium']) {
    assert.ok(DENYLIST_PATH_SUBSTRINGS.includes(slug), `${slug} must be denylisted`);
  }
});

/**
 * `environment: "*"` is Fabric's default — it means the author never declared a side. Trusting
 * it as proof of server support made the jar skip the Modrinth lookup that would have caught it.
 */
test('environment "*" is undecided, not a claim of server support', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-env-'));

  const write = (jar: string, meta: Record<string, unknown>) => {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta)));
    zip.writeZip(path.join(dir, jar));
    return path.join(dir, jar);
  };

  assert.equal(jarDeclaresClientOnly(write('star.jar', { id: 'a', environment: '*' })), null);
  assert.equal(jarDeclaresClientOnly(write('client.jar', { id: 'b', environment: 'client' })), true);
  assert.equal(jarDeclaresClientOnly(write('server.jar', { id: 'c', environment: 'server' })), false);
  assert.equal(jarDeclaresClientOnly(write('none.jar', { id: 'd' })), null);
});

/**
 * FTB Quests is not on Modrinth, so the hash lookup cannot classify it and it reaches the
 * last-resort pass. It must survive: a bytecode scan for client-only API references disabled it
 * (it registers client handlers from its `main` entrypoint behind an environment guard), and
 * players joined a healthy server only to find the quest book dead.
 */
test('mods Modrinth cannot identify are kept unless the filename says otherwise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-unknown-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  const zip = new AdmZip();
  zip.addFile(
    'fabric.mod.json',
    Buffer.from(JSON.stringify({ id: 'ftbquests', environment: '*', entrypoints: { main: ['dev.ftb.quests.FTBQuests'] } }))
  );
  zip.addFile(
    'dev/ftb/quests/FTBQuests.class',
    Buffer.from('constant pool net/minecraft/client/gui/screen/Screen guarded reference', 'latin1')
  );
  zip.writeZip(path.join(modsDir, 'ftb-quests-1.20.1.jar'));

  const result = await quarantineClientOnlyMods('test-server', dir);

  assert.deepEqual(result.moved, [], 'an unidentifiable server mod must not be disabled');
  assert.ok(fs.existsSync(path.join(modsDir, 'ftb-quests-1.20.1.jar')));
});

/**
 * The panel has to be able to say *why* a mod is gone. "59 mods disabled" with the reasons only in
 * console scrollback is what turned a one-line problem into several rounds of screenshots.
 */
test('the health report records a distinct reason per quarantine pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-report-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  const write = (jar: string, meta: Record<string, unknown>) => {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta)));
    zip.writeZip(path.join(modsDir, jar));
  };

  write('missingmodschecker.jar', { id: 'mmc', environment: '*' });
  write('someclientmod.jar', { id: 'someclientmod', environment: 'client' });
  write('needsit.jar', { id: 'needsit', environment: 'server', depends: { someclientmod: '*' } });
  write('fine.jar', { id: 'fine', environment: 'server' });

  const { report } = await quarantineClientOnlyMods('test-server', dir);
  const reasonFor = (jar: string) => report.quarantined.find((q) => q.fileName === jar)?.reason;

  assert.equal(reasonFor('missingmodschecker.jar'), 'denylist');
  assert.equal(reasonFor('someclientmod.jar'), 'declared-client');
  assert.equal(reasonFor('needsit.jar'), 'missing-dependency');
  assert.equal(
    report.quarantined.find((q) => q.fileName === 'needsit.jar')?.missingDependency,
    'someclientmod'
  );
  assert.equal(reasonFor('fine.jar'), undefined, 'a server-safe mod must not appear in the report');
  assert.equal(report.scanned, 4);
});

test('the report is persisted to the server directory and reads back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-persist-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'mmc', environment: '*' })));
  zip.writeZip(path.join(modsDir, 'missingmodschecker.jar'));

  await quarantineClientOnlyMods('test-server', dir);

  const persisted = readPackHealth(dir);
  assert.ok(persisted, 'the report file must exist after a scan');
  assert.equal(persisted!.quarantined[0].fileName, 'missingmodschecker.jar');
  assert.equal(persisted!.quarantined[0].reason, 'denylist');
});

/**
 * A soft dependency going missing never stops a boot, so it must not quarantine anything — but it
 * is precisely the signal that explains a feature silently not working, which is why it is
 * reported separately rather than ignored.
 */
test('missing soft dependencies are reported but do not disable anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-soft-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  const zip = new AdmZip();
  zip.addFile(
    'fabric.mod.json',
    Buffer.from(
      JSON.stringify({
        id: 'questaddon',
        environment: '*',
        depends: { minecraft: '1.20.1' },
        recommends: { ftbquests: '*' },
      })
    )
  );
  zip.writeZip(path.join(modsDir, 'questaddon.jar'));

  const { scanned, unresolved } = analyzeInstalledMods(dir);

  assert.equal(scanned, 1);
  const quests = unresolved.find((u) => u.id === 'ftbquests');
  assert.ok(quests, 'the missing optional dependency must be surfaced');
  assert.equal(quests!.hard, false);
  assert.deepEqual(quests!.requiredBy, ['questaddon.jar']);
  assert.ok(!unresolved.some((u) => u.id === 'minecraft'), 'loader-provided ids are always satisfied');
});

test('hard requirements outrank soft ones for the same dependency id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-rank-'));
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir);

  const write = (jar: string, meta: Record<string, unknown>) => {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta)));
    zip.writeZip(path.join(modsDir, jar));
  };

  write('soft.jar', { id: 'soft', recommends: { ftblibrary: '*' } });
  write('hard.jar', { id: 'hard', depends: { ftblibrary: '*' } });

  const { unresolved } = analyzeInstalledMods(dir);
  const lib = unresolved.find((u) => u.id === 'ftblibrary');

  assert.ok(lib);
  assert.equal(lib!.hard, true, 'one hard requirement makes the whole entry a hard miss');
  assert.equal(lib!.requiredBy.length, 2);
  assert.equal(unresolved[0].id, 'ftblibrary', 'hard misses sort first');
});

test('optional dependencies never trigger quarantine', () => {
  const dir = makeModsDir([
    { jar: 'sodium.jar', meta: { id: 'sodium', environment: 'client' } },
    { jar: 'soft.jar', meta: { id: 'soft', environment: '*', recommends: { sodium: '*' }, suggests: { sodium: '*' } } },
  ]);

  const clientOnly = new Set(['sodium.jar']);
  const orphaned = cascadeOrphanedDependents(dir, ['sodium.jar', 'soft.jar'], clientOnly);

  assert.equal(orphaned.length, 0);
  assert.ok(!clientOnly.has('soft.jar'), 'a recommended mod going missing does not stop a boot');
});
