import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pickMrpackVersion, isServerRelevant, parseModrinthEnv, resolveInsideDir } from './modrinth';

/**
 * Version selection decides whether a given modpack can be deployed at all. The regression
 * worth guarding is the loader assumption: filtering versions to `fabric` made every Forge,
 * NeoForge and Quilt pack look like it had no releases.
 */

const mrpack = (id: string, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  version_number: `v-${id}`,
  files: [{ primary: true, url: `https://cdn.modrinth.com/${id}.mrpack` }],
  ...extra,
});

test('picks the newest version that actually ships a .mrpack', () => {
  const chosen = pickMrpackVersion([mrpack('newest'), mrpack('older')]);
  assert.equal(chosen?.id, 'newest');
});

test('skips versions that carry no .mrpack instead of failing on them', () => {
  // Some projects attach a changelog or a client-only zip to a release.
  const versions = [
    { id: 'attachment-only', version_number: 'x', files: [{ primary: true, url: 'https://cdn.modrinth.com/notes.txt' }] },
    { id: 'no-files', version_number: 'y', files: [] },
    { id: 'missing-files-key', version_number: 'z' },
    mrpack('real'),
  ];
  assert.equal(pickMrpackVersion(versions)?.id, 'real');
});

test('finds a .mrpack that is not the primary file', () => {
  const versions = [
    {
      id: 'secondary',
      version_number: 'v',
      files: [
        { primary: true, url: 'https://cdn.modrinth.com/readme.txt' },
        { primary: false, url: 'https://cdn.modrinth.com/pack.mrpack' },
      ],
    },
  ];
  assert.equal(pickMrpackVersion(versions)?.id, 'secondary');
});

test('returns null when nothing is deployable', () => {
  assert.equal(pickMrpackVersion([]), null);
  assert.equal(pickMrpackVersion([{ id: 'a', files: [{ url: 'https://x/y.zip' }] }]), null);
});

test('server relevance keeps everything except explicitly unsupported files', () => {
  // A pack that marks a mod server-"unsupported" means it, but "optional" and an absent
  // env block must both still be installed or half the pack goes missing.
  assert.equal(isServerRelevant({ path: 'mods/a.jar', env: { server: 'unsupported' } }), false);
  assert.equal(isServerRelevant({ path: 'mods/b.jar', env: { server: 'required' } }), true);
  assert.equal(isServerRelevant({ path: 'mods/c.jar', env: { server: 'optional' } }), true);
  assert.equal(isServerRelevant({ path: 'mods/d.jar' }), true);
  assert.equal(isServerRelevant({ path: 'mods/e.jar', env: { client: 'required' } }), true);
});

test('unknown env values are treated as unknown rather than trusted', () => {
  assert.equal(parseModrinthEnv(undefined), 'unknown');
  assert.equal(parseModrinthEnv('nonsense'), 'unknown');
  assert.equal(parseModrinthEnv('REQUIRED'), 'required');
});

test('manifest paths cannot escape the server directory', () => {
  const base = path.resolve('/srv/data/abc');
  const contained = path.resolve(base) + path.sep;

  // Asserted as "rejected or contained" rather than "returns null for this exact input":
  // what counts as an absolute path differs between win32 and posix, and the daemon only
  // ever runs on Linux. The invariant that matters holds on both.
  for (const hostile of ['../../etc/passwd', '/etc/passwd', '..\\..\\windows\\system32', 'a/../../../b', '']) {
    const resolved = resolveInsideDir(base, hostile);
    if (resolved !== null) {
      assert.ok(
        resolved.startsWith(contained),
        `'${hostile}' resolved outside the server directory: ${resolved}`
      );
    }
  }

  assert.equal(resolveInsideDir(base, ''), null);
  assert.ok(resolveInsideDir(base, 'mods/ok.jar')?.startsWith(contained));
});
