import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { blocks, hasGeneratedWorld, preflight } from './preflight';

function dirWith(entries: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
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

/** The SkyFactory directory as it actually was: Forge 1.12.2 files, Fabric in the panel. */
const SKYFACTORY = [
  'forge-1.12.2-14.23.5.2860-installer.jar',
  'ServerStart.sh',
  'settings.sh',
  'mods/a.jar',
  'mods/b.jar',
];

const find = (fs_: ReturnType<typeof preflight>, id: string) => fs_.find((f) => f.id === id);

test('the SkyFactory case: every problem is named, and each carries its fix', () => {
  const findings = preflight({
    serverDir: dirWith(SKYFACTORY),
    serverType: 'FABRIC',
    mcVersion: 'LATEST',
    availableJava: 17,
  });

  const loader = find(findings, 'loader-mismatch');
  assert.ok(loader, 'loader mismatch not reported');
  assert.equal(loader!.fix?.action, 'set-engine');
  assert.equal(loader!.fix?.serverType, 'FORGE');
  assert.equal(loader!.fix?.mcVersion, '1.12.2');

  const version = find(findings, 'version-latest');
  assert.ok(version, 'LATEST on an old pack not reported');
  assert.equal(version!.fix?.mcVersion, '1.12.2');

  // The whole point of the exercise: this is a block, not a warning.
  assert.ok(blocks(findings));
});

test('Java is judged against the corrected server, not the broken one', () => {
  /*
   * The server says Fabric/LATEST, which needs a modern JVM and would pass. What will
   * actually run is Forge 1.12.2, which cannot use Java 17 at all. Reasoning about the
   * configuration as written would clear it and let the fixed server fail instead.
   */
  const findings = preflight({
    serverDir: dirWith(SKYFACTORY),
    serverType: 'FABRIC',
    mcVersion: 'LATEST',
    availableJava: 17,
  });

  const java = find(findings, 'java-too-new');
  assert.ok(java, 'expected the Java ceiling to be caught');
  assert.match(java!.detail, /LaunchWrapper/);
  // Nothing to click: a JDK cannot be conjured, and changing the Minecraft version to
  // suit the JVM would be backwards.
  assert.equal(java!.fix, undefined);
});

test('Docker nodes are not warned about Java, because the image tag decides it', () => {
  const findings = preflight({
    serverDir: dirWith(SKYFACTORY),
    serverType: 'FABRIC',
    mcVersion: 'LATEST',
    availableJava: 17,
    dockerMode: true,
  });
  assert.equal(find(findings, 'java-too-new'), undefined);
  // The loader is still wrong, though — that has nothing to do with containers.
  assert.ok(find(findings, 'loader-mismatch'));
});

test('a world from a bad boot is flagged, but only while something else is being fixed', () => {
  const withWorld = dirWith([...SKYFACTORY, 'world/level.dat']);
  const stale = find(preflight({ serverDir: withWorld, serverType: 'FABRIC', mcVersion: 'LATEST' }), 'stale-world');
  assert.ok(stale, 'expected the leftover world to be flagged');
  assert.equal(stale!.severity, 'warn');
  assert.equal(stale!.fix?.action, 'rescue-world');
  // Never deleted, and the message has to say so — this is somebody's world.
  assert.match(stale!.detail, /Nothing is deleted/);

  // A correctly configured server with a world is just a server with a world.
  const healthy = dirWith(['fabric-server-launch.jar', 'mods/a.jar', 'world/level.dat']);
  assert.equal(find(preflight({ serverDir: healthy, serverType: 'FABRIC', mcVersion: '1.21.1' }), 'stale-world'), undefined);
});

test('an empty world folder is not a generated world', () => {
  // Plenty of things create the directory; only a server that generated terrain writes
  // level.dat. Offering to rescue an empty folder would be noise.
  assert.equal(hasGeneratedWorld(dirWith(['world/'])), false);
  assert.equal(hasGeneratedWorld(dirWith(['world/level.dat'])), true);
});

test('a healthy server produces nothing at all', () => {
  const findings = preflight({
    serverDir: dirWith(['fabric-server-launch.jar', 'mods/a.jar']),
    serverType: 'FABRIC',
    mcVersion: '1.21.1',
    availableJava: 21,
  });
  assert.deepEqual(findings, []);
});

test('a vanilla server on an old version is left alone', () => {
  /*
   * 1.12.2 vanilla runs fine on a modern JVM — the ceiling is a Forge problem, not an age
   * problem. Catching this would refuse a working server.
   */
  const findings = preflight({
    serverDir: dirWith(['server.jar']),
    serverType: 'VANILLA',
    mcVersion: '1.12.2',
    availableJava: 21,
  });
  assert.equal(find(findings, 'java-too-new'), undefined);
  assert.deepEqual(findings, []);
});

test('a JVM too old for a modern version is still caught', () => {
  const findings = preflight({
    serverDir: dirWith(['fabric-server-launch.jar', 'mods/a.jar']),
    serverType: 'FABRIC',
    mcVersion: '26.2',
    availableJava: 17,
  });
  const java = find(findings, 'java-too-old');
  assert.ok(java);
  assert.match(java!.detail, /needs Java 25/);
});

test('an unknown Java version is not treated as a problem', () => {
  // The probe failing is not evidence of anything, and refusing to start on it would
  // break working nodes to prevent a message.
  const findings = preflight({
    serverDir: dirWith(SKYFACTORY),
    serverType: 'FORGE',
    mcVersion: '1.12.2',
    availableJava: null,
  });
  assert.deepEqual(findings, []);
});

test('a bare server with no mods yet is never blocked on its loader', () => {
  // Somebody who made a Fabric server and has not added mods to it is not making a
  // mistake, whatever stray jars are lying around.
  const findings = preflight({
    serverDir: dirWith(['forge-1.12.2-14.23.5.2860-installer.jar', 'mods/']),
    serverType: 'FABRIC',
    mcVersion: '1.21.1',
    availableJava: 21,
  });
  assert.equal(find(findings, 'loader-mismatch'), undefined);
});

test('a node with Java 8 available is clean for an old Forge pack', () => {
  /*
   * The whole point of shipping Java 8 in the node image. This is the state the SkyFactory
   * server should reach once it is set up correctly: nothing left to report.
   *
   * It also guards the floor-versus-ceiling bug — requiredJavaMajor bottoms out at 17, so
   * running both rules here reported Java 8 as too old for a pack that needs exactly 8.
   */
  const findings = preflight({
    serverDir: dirWith(['forge-1.12.2-14.23.5.2859-universal.jar', 'mods/a.jar']),
    serverType: 'FORGE',
    mcVersion: '1.12.2',
    availableJava: 8,
  });
  assert.deepEqual(findings, []);
});

test('an old Forge pack on a node with only Java 17 is still blocked', () => {
  const findings = preflight({
    serverDir: dirWith(['forge-1.12.2-14.23.5.2859-universal.jar', 'mods/a.jar']),
    serverType: 'FORGE',
    mcVersion: '1.12.2',
    availableJava: 17,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'java-too-new');
});

test('a Fabric pack pinned to an old version is caught before it is started', () => {
  /*
   * The StarT case. A Fabric launcher jar carries no version in its name, so nothing in
   * the directory said which Minecraft this pack was for — it started, resolved LATEST to
   * the newest release, and the loader refused every mod. The mods knew all along.
   */
  const AdmZip = require('adm-zip');
  const dir = dirWith(['fabric-server-launch.jar']);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  const zip = new AdmZip();
  zip.addFile(
    'fabric.mod.json',
    Buffer.from(JSON.stringify({ id: 'ftbquestsfreezefix', depends: { minecraft: '1.20.1', 'fabric-api': '*' } }))
  );
  zip.writeZip(path.join(dir, 'mods', 'ftbquestsfreezefix.jar'));

  const findings = preflight({ serverDir: dir, serverType: 'FABRIC', mcVersion: '26.2', availableJava: 21 });

  const version = find(findings, 'pack-version-mismatch');
  assert.ok(version, 'the pack version was not checked');
  assert.equal(version!.fix?.mcVersion, '1.20.1');
  assert.equal(version!.fix?.serverType, 'FABRIC');
  // The mods are not the problem, and the wording has to say so.
  assert.match(version!.detail, /the version is/);

  const api = find(findings, 'fabric-api-missing');
  assert.ok(api, 'the missing Fabric API was not reported');
  assert.equal(api!.fix, undefined, 'this one needs a jar downloaded, so there is nothing to click');
});

test('a pack on the version it asks for raises nothing', () => {
  const AdmZip = require('adm-zip');
  const dir = dirWith(['fabric-server-launch.jar']);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'a', depends: { minecraft: '1.20.1' } })));
  zip.writeZip(path.join(dir, 'mods', 'a.jar'));

  assert.deepEqual(preflight({ serverDir: dir, serverType: 'FABRIC', mcVersion: '1.20.1', availableJava: 21 }), []);
});
