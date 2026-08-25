import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jarLoader, jarSuitsLoader } from './server-type';

/*
 * Tested against jars the real services actually serve.
 *
 * The whole point of reading a manifest is that it describes the artefact rather than
 * whatever it was named on the way in. Synthetic jars would prove only that the regex
 * matches a string this file also wrote.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jar-loader-'));

async function fetchTo(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return false;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

test('a Fabric server download is recognised as Fabric, whatever it is named', async (t) => {
  /*
   * The failure this exists for. The Fabric server jar is written to disk as `server.jar`,
   * so a directory that once ran Fabric keeps a Fabric launcher under a name that says
   * nothing — and "if server.jar exists, use it" started it for a Forge server. Its
   * Main-Class is net.fabricmc.installer.ServerLauncher, which is the exact frame at the
   * top of the crash this fixes.
   */
  const dir = tmp();
  const jar = path.join(dir, 'server.jar');

  const meta = await fetch('https://meta.fabricmc.net/v2/versions/loader/1.21.1').catch(() => null);
  if (!meta?.ok) return t.skip('no network');
  const loaderVer = (await meta.json())[0]?.loader?.version;
  const installer = await (await fetch('https://meta.fabricmc.net/v2/versions/installer')).json();

  const ok = await fetchTo(
    `https://meta.fabricmc.net/v2/versions/loader/1.21.1/${loaderVer}/${installer[0].version}/server/jar`,
    jar
  );
  if (!ok) return t.skip('could not fetch the Fabric jar');

  assert.equal(jarLoader(jar), 'FABRIC');
  // The name says server.jar; only the manifest knows better.
  assert.equal(jarSuitsLoader(jar, 'FORGE'), false);
  assert.equal(jarSuitsLoader(jar, 'FABRIC'), true);
});

test('a Forge artefact is recognised as Forge', async (t) => {
  const dir = tmp();
  const jar = path.join(dir, 'server.jar');
  const ok = await fetchTo(
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859-installer.jar',
    jar
  );
  if (!ok) return t.skip('no network');

  assert.equal(jarLoader(jar), 'FORGE');
  assert.equal(jarSuitsLoader(jar, 'FABRIC'), false);
});

test('an unreadable jar produces no opinion, and is left in place', () => {
  /*
   * Deliberately permissive. Re-downloading a server because a manifest could not be
   * parsed would be a worse failure than the one being prevented, so no evidence means
   * the existing jar is kept.
   */
  const dir = tmp();
  const jar = path.join(dir, 'server.jar');
  fs.writeFileSync(jar, 'not a zip at all');

  assert.equal(jarLoader(jar), null);
  assert.equal(jarSuitsLoader(jar, 'FORGE'), true);
});

test('a missing jar is not a crash', () => {
  assert.equal(jarLoader(path.join(tmp(), 'absent.jar')), null);
});

test('a non-loader server type accepts whatever is there', () => {
  // Paper and Vanilla have no loader to contradict.
  const dir = tmp();
  const jar = path.join(dir, 'server.jar');
  fs.writeFileSync(jar, 'whatever');
  assert.equal(jarSuitsLoader(jar, 'PAPER'), true);
  assert.equal(jarSuitsLoader(jar, undefined), true);
});
