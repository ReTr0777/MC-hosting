import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listBuiltinThemes, readBuiltinTheme } from './builtin-themes';

/**
 * These files are served only to signed-in users, so the two things worth proving are that
 * they are readable at all from the runtime's working directory, and that a slug cannot be
 * used to read anything else on disk.
 */

test('the bundled themes are found and parsed', () => {
  const themes = listBuiltinThemes();
  const names = themes.map((t) => t.name);

  assert.ok(themes.length >= 3, `expected the shipped themes, got ${names.join(', ') || 'none'}`);
  assert.ok(names.includes('Sakura Night'));
  assert.ok(names.includes('Sakura Drift'));
  assert.ok(names.includes('Cherry Blossom'));

  const night = themes.find((t) => t.name === 'Sakura Night')!;
  assert.equal(night.scheme, 'dark');
  assert.equal(night.swatch.length, 3);
  assert.ok(night.swatch.every((c) => c.startsWith('#')), 'swatches should be plain colours');
});

test('theme files are no longer inside public/', () => {
  // public/ is served with no authentication, which is the whole reason they moved.
  const publicThemes = path.join(process.cwd(), 'public', 'themes');
  assert.equal(fs.existsSync(publicThemes), false, 'themes must not be statically served');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'themes')), true);
});

test('a slug cannot escape the themes directory', () => {
  for (const slug of [
    '../package',
    '../../package',
    '..%2Fpackage',
    '/etc/passwd',
    'foo/bar',
    'foo\\bar',
    '.',
    '..',
    '',
    'a'.repeat(200),
  ]) {
    assert.equal(readBuiltinTheme(slug), null, `${slug} must not resolve to a file`);
  }
});

test('an unknown but well-formed slug returns null rather than throwing', () => {
  assert.equal(readBuiltinTheme('no-such-theme'), null);
});

test('a known slug returns the file', () => {
  const source = readBuiltinTheme('sakura-night');
  assert.ok(source);
  assert.ok(source.includes('@name Sakura Night'));
});
