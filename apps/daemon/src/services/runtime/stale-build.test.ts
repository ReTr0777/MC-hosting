import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The metadata merge that made the staleness check unreachable.
 *
 * ensureServerJar is not callable in isolation — it downloads, spawns and writes — so what
 * is pinned here is the piece that was actually wrong: the order of the spread, and the
 * values the comparison is made against. The bug was entirely in those two lines.
 */

/** How the meta used to be assembled, and then immediately compared against itself. */
function staleCheckBefore(existing: any, mcVersion: string, serverType: string) {
  let meta: any = { mcVersion, serverType, installedVersion: mcVersion };
  meta = { ...existing, ...meta };
  const recorded = meta.installedVersion || meta.mcVersion;
  return { changed: Boolean(recorded && recorded !== mcVersion), recorded };
}

/** How it is assembled now: what was on disk is read before anything overwrites it. */
function staleCheckAfter(existing: any, mcVersion: string, serverType: string) {
  const recordedVersion = existing.installedVersion || existing.mcVersion;
  const recordedLoader = String(existing.installedLoader || existing.serverType || '').toUpperCase();
  return {
    versionChanged: Boolean(recordedVersion && recordedVersion !== mcVersion),
    loaderChanged: Boolean(recordedLoader && recordedLoader !== serverType.toUpperCase()),
    recordedVersion,
  };
}

const FABRIC_LATEST_ON_DISK = { mcVersion: '26.2', installedVersion: '26.2', serverType: 'FABRIC' };

test('the old merge made a changed version look unchanged', () => {
  /*
   * The requested version was spread over the recorded one and then compared to itself, so
   * the answer was always "no change" — the rescue that clears a stale build could never
   * run. Leftovers from every earlier attempt stayed in the directory and were launched in
   * preference to what the server was actually set to.
   */
  const before = staleCheckBefore(FABRIC_LATEST_ON_DISK, '1.12.2', 'FORGE');
  assert.equal(before.recorded, '1.12.2', 'the recorded version had already been overwritten');
  assert.equal(before.changed, false, 'this is the bug: a 26.2 -> 1.12.2 change read as no change');
});

test('the version change is now seen', () => {
  const after = staleCheckAfter(FABRIC_LATEST_ON_DISK, '1.12.2', 'FORGE');
  assert.equal(after.recordedVersion, '26.2');
  assert.ok(after.versionChanged);
});

test('a loader change is seen even when the version is identical', () => {
  // Switching Fabric to Forge on the same Minecraft version leaves a directory full of
  // Fabric artefacts that the version check alone would never clear.
  const after = staleCheckAfter(
    { mcVersion: '1.20.1', installedVersion: '1.20.1', serverType: 'FABRIC' },
    '1.20.1',
    'FORGE'
  );
  assert.equal(after.versionChanged, false);
  assert.ok(after.loaderChanged, 'a Fabric -> Forge switch has to count as stale');
});

test('an unchanged server is not disturbed', () => {
  const after = staleCheckAfter(FABRIC_LATEST_ON_DISK, '26.2', 'FABRIC');
  assert.equal(after.versionChanged, false);
  assert.equal(after.loaderChanged, false);
});

test('a directory with no metadata is not treated as stale', () => {
  // A fresh server has nothing recorded. Rescuing on that would move files out of a
  // directory that was just built correctly.
  const after = staleCheckAfter({}, '1.12.2', 'FORGE');
  assert.equal(after.versionChanged, false);
  assert.equal(after.loaderChanged, false);
});

/** The comparison as it is now: only a real install counts as a record. */
function staleCheckInstalledOnly(existing: any, mcVersion: string, serverType: string) {
  const recordedVersion: string | undefined = existing.installedVersion;
  const recordedLoader = String(existing.installedLoader || '').toUpperCase();
  return {
    versionChanged: Boolean(recordedVersion && recordedVersion !== mcVersion),
    loaderChanged: Boolean(recordedLoader && recordedLoader !== serverType.toUpperCase()),
  };
}

test('a fresh LATEST server is not rescued on every single start', () => {
  /*
   * The regression this pins. craftcontrol-meta.json is written from the DTO, so a server
   * left on LATEST records mcVersion "LATEST" while the resolved version is "26.2".
   * Treating that as a record made them differ forever: the rescue fired on every start,
   * moved the world aside, re-downloaded, and looped — displacing the world each time.
   */
  const fromDto = { mcVersion: 'LATEST', serverType: 'FABRIC' };

  const withFallback = staleCheckAfter(fromDto, '26.2', 'FABRIC');
  assert.ok(withFallback.versionChanged, 'the old comparison saw a change that was not there');

  const now = staleCheckInstalledOnly(fromDto, '26.2', 'FABRIC');
  assert.equal(now.versionChanged, false, 'a request is not a record');
  assert.equal(now.loaderChanged, false);
});

test('a genuine install is still recognised as stale when it changes', () => {
  const installed = { installedVersion: '26.2', installedLoader: 'FABRIC', mcVersion: 'LATEST', serverType: 'FORGE' };
  const now = staleCheckInstalledOnly(installed, '1.12.2', 'FORGE');
  assert.ok(now.versionChanged);
  assert.ok(now.loaderChanged);
});

test('a directory that never completed an install has nothing to rescue', () => {
  // A failed first attempt leaves the request but no installedVersion. Rescuing there
  // would move files that were never successfully put in place.
  const now = staleCheckInstalledOnly({ mcVersion: '1.12.2', serverType: 'FORGE' }, '1.12.2', 'FORGE');
  assert.equal(now.versionChanged, false);
  assert.equal(now.loaderChanged, false);
});
