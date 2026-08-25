import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConcreteVersion,
  resolveForgeBuild,
  resolveNeoForgeBuild,
  resolveVanillaJarUrl,
} from './forge-install';

/*
 * These call the real Forge, NeoForge and Mojang endpoints.
 *
 * Deliberately, because the thing worth protecting is the agreement with those services:
 * the shape of promotions_slim.json, the Maven path layout, the manifest's nesting. A
 * mocked version of all three would keep passing after any of them changed, which is the
 * only way this code can break.
 *
 * Each skips rather than fails when the network is unavailable, so an offline build does
 * not report a fault that is not there.
 */

async function online(): Promise<boolean> {
  try {
    const res = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test('a Forge build is published for 1.12.2, and its installer really exists', async (t) => {
  if (!(await online())) return t.skip('no network');

  const build = await resolveForgeBuild('1.12.2');
  assert.ok(build, 'no build resolved for 1.12.2');
  // 14.23.5.x has been the 1.12.2 line for years; anything else means the shape changed.
  assert.match(build!, /^\d+\.\d+\.\d+\.\d+$/);

  const url =
    `https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-${build}/forge-1.12.2-${build}-installer.jar`;
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  assert.equal(head.status, 200, `installer missing at ${url}`);
  // A few megabytes. A 200 serving an error page would sail past a status check alone.
  assert.ok(Number(head.headers.get('content-length')) > 1_000_000);
});

test('a version with no Forge at all resolves to null rather than a bad URL', async (t) => {
  if (!(await online())) return t.skip('no network');
  assert.equal(await resolveForgeBuild('1.99.7'), null);
});

test('the vanilla jar resolves through Mojang, for old versions and for LATEST', async (t) => {
  if (!(await online())) return t.skip('no network');

  const old = await resolveVanillaJarUrl('1.12.2');
  assert.ok(old, 'no vanilla jar for 1.12.2');
  assert.match(old!, /^https:\/\//);

  // LATEST has to mean the current release, not a literal version id lookup that fails.
  assert.ok(await resolveVanillaJarUrl('LATEST'), 'LATEST did not resolve');
});

test('a Minecraft version Mojang never shipped resolves to null', async (t) => {
  if (!(await online())) return t.skip('no network');
  assert.equal(await resolveVanillaJarUrl('1.99.7'), null);
});

test('NeoForge builds are matched to their Minecraft version', async (t) => {
  if (!(await online())) return t.skip('no network');

  // Minecraft 1.21.1 maps to the 21.1.x line — the numbering drops the leading "1.".
  const build = await resolveNeoForgeBuild('1.21.1');
  assert.ok(build, 'no NeoForge build for 1.21.1');
  assert.ok(build!.startsWith('21.1.'), `expected a 21.1.x build, got ${build}`);
});

test('NeoForge does not exist for old versions, and says so', async (t) => {
  if (!(await online())) return t.skip('no network');
  // NeoForge forked at 1.20.2; there has never been a 1.12.2 build.
  assert.equal(await resolveNeoForgeBuild('1.12.2'), null);
});

test('LATEST resolves to a real version before it reaches any loader API', async (t) => {
  if (!(await online())) return t.skip('no network');

  const resolved = await resolveConcreteVersion('LATEST');
  assert.ok(resolved, 'LATEST did not resolve');
  assert.notEqual(resolved, 'LATEST');

  // The failure this fixes: Fabric's meta API answers 400 for the literal string, so a
  // server left on LATEST could not be installed at all.
  const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${resolved}`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(res.status, 200, `Fabric rejected the resolved version ${resolved}`);
});

test('a concrete version is passed through untouched', async () => {
  // No network call for a version that is already a version.
  assert.equal(await resolveConcreteVersion('1.12.2'), '1.12.2');
});
