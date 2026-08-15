import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listBuiltinThemes, readBuiltinTheme } from './builtin-themes';
import { parseThemeFile } from './theme-tokens';

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
  assert.ok(names.includes('Aurora Vault'));
  assert.ok(names.includes('Meadow Light'));

  const night = themes.find((t) => t.name === 'Sakura Night')!;
  assert.equal(night.scheme, 'dark');
  assert.equal(night.swatch.length, 3);
  assert.ok(night.swatch.every((c) => c.startsWith('#')), 'swatches should be plain colours');
});

/**
 * Every bundled file, rather than a named list: an illustrated theme carries tens of
 * kilobytes of embedded SVG, and both failure modes here are silent. Past 64 KB the parser
 * rejects the file outright, and a value it does not recognise is dropped with a warning —
 * either way the theme still appears in the picker and simply does not apply properly.
 */
test('every bundled theme parses cleanly and stays within the parser limits', () => {
  const dir = path.join(process.cwd(), 'themes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
  assert.ok(files.length > 0, 'expected bundled theme files');

  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(
      source.length <= 64 * 1024,
      `${file} is ${(source.length / 1024).toFixed(1)} KB, over the 64 KB limit the parser enforces`
    );

    const { theme, errors, warnings } = parseThemeFile(source, file);
    assert.ok(theme, `${file} failed to parse: ${errors.join(' ')}`);
    assert.deepEqual(warnings, [], `${file} should import with nothing ignored`);
  }
});

test('the illustrated themes set a full palette and both decoration layers', () => {
  for (const slug of ['sakura-night', 'aurora-vault', 'ember-fall', 'abyssal-tide', 'meadow-light', 'neon-rain']) {
    const source = readBuiltinTheme(slug);
    assert.ok(source, `${slug} should be bundled`);

    const { theme } = parseThemeFile(source);
    assert.ok(theme, `${slug} should parse`);
    // The still scene and the moving tile are painted on different elements, so a theme
    // missing one of them loses either its backdrop or its weather.
    assert.ok(theme.tokens['--bg-scene'], `${slug} should set --bg-scene`);
    assert.ok(theme.tokens['--bg-image'], `${slug} should set --bg-image`);
    // Both motions travel in multiples of 480px; any other tile size jumps at the loop point.
    assert.ok(
      ['240px', '480px'].includes(theme.tokens['--bg-size'] || ''),
      `${slug} has --bg-size ${theme.tokens['--bg-size']}, which will not tile seamlessly`
    );
  }
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
