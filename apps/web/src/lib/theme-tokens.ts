/**
 * Custom theme files.
 *
 * A theme file looks like ordinary CSS, but it is never executed as CSS. It is parsed for
 * a known set of design tokens, every value is validated against a colour grammar, and the
 * panel then regenerates a stylesheet from the validated values alone.
 *
 * That indirection is the whole security model. Themes are meant to be shared between
 * users, and a stylesheet applied verbatim can exfiltrate data through `url()` requests,
 * pull in remote CSS with `@import`, and cover real buttons with invisible fixed-position
 * overlays. Because nothing from the uploaded file is ever emitted as-is — only recognised
 * token names carrying values that matched a colour pattern — none of that survives the
 * round trip.
 */

/** Colour tokens. Every theme resolves to a complete set of these. */
export const COLOR_TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--border',
  '--border-2',
  '--text-primary',
  '--text-muted',
  '--accent',
  '--accent-dim',
  '--accent-border',
  '--on-accent',
  '--warning',
  '--danger',
  '--advanced',
  '--advanced-solid',
  '--advanced-dim',
  '--advanced-border',
] as const;

/**
 * Optional background decoration. Unset on every built-in theme, so a plain colour theme
 * behaves exactly as before.
 *
 * `--bg-image` accepts an embedded `data:` image and nothing else. The ban on `url()`
 * exists to stop a shared theme phoning home — a data URI makes no network request at all,
 * so it carries none of that risk while still allowing real artwork in a theme file.
 */
export const DECORATION_TOKENS = ['--bg-image', '--bg-size', '--bg-animation', '--bg-scene'] as const;

/** Every token a theme may set. Anything else in the file is ignored. */
export const THEME_TOKENS = [...COLOR_TOKENS, ...DECORATION_TOKENS] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type DecorationToken = (typeof DECORATION_TOKENS)[number];
export type ThemeToken = ColorToken | DecorationToken;

type TokenKind = 'color' | 'image' | 'size' | 'animation';

const TOKEN_KIND: Record<ThemeToken, TokenKind> = {
  ...(Object.fromEntries(COLOR_TOKENS.map((t) => [t, 'color'])) as Record<ColorToken, TokenKind>),
  '--bg-image': 'image',
  '--bg-size': 'size',
  '--bg-animation': 'animation',
  '--bg-scene': 'image',
};

/**
 * `--bg-scene` is a single non-repeating illustration drawn behind everything and held
 * still, for a composed backdrop rather than a pattern. `--bg-image` tiles and moves over
 * the top of it. They are separate tokens because they are painted on separate elements —
 * see the html/body split in globals.css.
 */

/** Background motion is a fixed menu, not free-form CSS — see globals.css for the keyframes. */
export const BG_ANIMATIONS = ['none', 'drift', 'fall'] as const;

export interface CustomTheme {
  /** Stable id, derived from the name. Prefixed `custom:` everywhere it is used as a theme key. */
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Decides which built-in palette fills in any token the file leaves out. */
  scheme: 'dark' | 'light';
  tokens: Partial<Record<ThemeToken, string>>;
}

export interface ParseResult {
  theme: CustomTheme | null;
  /** Problems that stopped the file being used at all. */
  errors: string[];
  /** Things that were skipped but did not stop the import. */
  warnings: string[];
}

const TOKEN_SET = new Set<string>(THEME_TOKENS);

/** Colour keywords worth supporting; anything more exotic can be written as hex. */
const NAMED_COLORS = new Set([
  'transparent', 'currentcolor', 'black', 'white', 'red', 'green', 'blue', 'yellow',
  'orange', 'purple', 'pink', 'gray', 'grey', 'cyan', 'magenta', 'brown', 'navy',
  'teal', 'olive', 'maroon', 'lime', 'silver', 'gold', 'beige', 'ivory', 'coral',
  'crimson', 'indigo', 'violet', 'salmon', 'khaki', 'plum', 'orchid', 'tan',
]);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// rgb/rgba/hsl/hsla in both legacy comma syntax and modern space syntax.
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-z.%,\/\s+-]+\)$/i;

/**
 * True when a value is a colour and nothing else.
 *
 * Deliberately strict: no `url()`, no `var()`, no nested functions, no multiple values, no
 * comments, no semicolons or braces that could close the declaration and open a new rule.
 */
export function isValidTokenValue(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 64) return false;

  // Structural characters would let a value escape its declaration.
  if (/[;{}<>\\]/.test(value)) return false;
  if (value.includes('/*') || value.includes('*/')) return false;
  if (/url\s*\(|@import|expression\s*\(|var\s*\(|attr\s*\(|image-set/i.test(value)) return false;

  if (HEX.test(value)) return true;
  if (NAMED_COLORS.has(value.toLowerCase())) return true;
  if (FUNCTIONAL.test(value)) {
    // A functional value must contain exactly one set of parentheses.
    return (value.match(/\(/g) || []).length === 1 && (value.match(/\)/g) || []).length === 1;
  }
  return false;
}

/**
 * True for an embedded image and nothing else.
 *
 * Only `data:` URIs pass, which is what makes this safe to accept from a shared theme: a
 * data URI cannot reach the network, so it cannot be used to report that you opened the
 * panel or to leak values through a crafted request. SVG referenced from CSS is rendered
 * in a restricted mode where scripts never run, but script-ish content is rejected here
 * anyway rather than relying on that alone.
 */
export function isValidImageValue(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.toLowerCase() === 'none') return true;
  if (value.length > 512 * 1024) return false;

  const match = value.match(/^url\(\s*(['"]?)(data:image\/(?:svg\+xml|png|jpeg|gif|webp)[,;][\s\S]*?)\1\s*\)$/i);
  if (!match) return false;

  const payload = match[2];
  // A stray quote or paren would end the url() early and let the rest become new syntax.
  if (/[;{}]/.test(payload.replace(/^data:image\/[a-z+]+;base64/i, ''))) return false;
  if (payload.includes(match[1]) && match[1] !== '') return false;
  if (/<\s*script|onload\s*=|onerror\s*=|javascript:|<\s*foreignObject/i.test(decodeURIComponentSafe(payload))) return false;

  return true;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Lengths, percentages and the standard background-size keywords. */
export function isValidSizeValue(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 40) return false;
  if (/[;{}()<>\\]/.test(value)) return false;
  if (value === 'auto' || value === 'cover' || value === 'contain') return true;
  // At most two components, each a length or percentage.
  const parts = value.split(/\s+/);
  if (parts.length > 2) return false;
  return parts.every((p) => /^\d+(\.\d+)?(px|em|rem|%|vw|vh)$/.test(p) || p === 'auto');
}

/** Dispatches to the right validator for the token being set. */
export function isValidValueForToken(token: ThemeToken, value: string): boolean {
  switch (TOKEN_KIND[token]) {
    case 'image':
      return isValidImageValue(value);
    case 'size':
      return isValidSizeValue(value);
    case 'animation':
      return (BG_ANIMATIONS as readonly string[]).includes(value.trim().toLowerCase());
    default:
      return isValidTokenValue(value);
  }
}

/** Turns a display name into a filesystem- and URL-safe id. */
export function themeIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'custom-theme';
}

/** Reads `/* @name Foo *\/` style metadata headers. */
function readMeta(source: string, key: string): string | null {
  const match = source.match(new RegExp(`@${key}\\s+([^\\n*]+)`, 'i'));
  return match ? match[1].trim().slice(0, 120) : null;
}

/**
 * Parses an uploaded theme file.
 *
 * Unrecognised properties and invalid values are reported as warnings rather than
 * rejections, so one bad line does not throw away an otherwise good theme.
 */
export function parseThemeFile(source: string, fallbackName = 'Custom theme'): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!source || !source.trim()) {
    return { theme: null, errors: ['The file is empty.'], warnings };
  }
  if (source.length > 64 * 1024) {
    return { theme: null, errors: ['Theme files must be smaller than 64 KB.'], warnings };
  }

  const name = readMeta(source, 'name') || fallbackName;
  const author = readMeta(source, 'author') || undefined;
  const description = readMeta(source, 'description') || undefined;
  const schemeRaw = (readMeta(source, 'scheme') || 'dark').toLowerCase();
  const scheme: 'dark' | 'light' = schemeRaw === 'light' ? 'light' : 'dark';

  // Metadata lives in comments, so it is read above — from here on comments are stripped.
  // A commented-out declaration must not be honoured, and a comment that merely mentions
  // url() (this project's own theme files explain that url() is ignored) must not be
  // reported as an attempt to use one.
  const body = source.replace(/\/\*[\s\S]*?\*\//g, ' ');

  if (/@import/i.test(body)) {
    warnings.push('An @import was found and ignored — themes cannot load external stylesheets.');
  }
  // Embedded images are removed before the scan below. An SVG data URI legitimately contains
  // its own internal `url(#gradientId)` references, and those are part of the payload rather
  // than CSS-level requests — scanning over them would report every illustrated theme as
  // reaching off-box.
  const withoutEmbedded = body.replace(
    /url\(\s*"data:[^"]*"\s*\)|url\(\s*'data:[^']*'\s*\)|url\(\s*data:[^)\s]*\s*\)/gi,
    ' '
  );

  // Checked per occurrence rather than with a negative lookahead: `['"]?(?!data:)` happily
  // backtracks the optional quote to empty and then "succeeds" against the quote itself, so
  // every legitimate url("data:...) would be reported as external.
  const urlRefs = withoutEmbedded.match(/url\s*\(\s*['"]?[^)'"]*/gi) || [];
  if (urlRefs.some((ref) => !/^url\s*\(\s*['"]?data:/i.test(ref))) {
    warnings.push('An external url() was found and ignored — themes may only embed images as data: URIs.');
  }

  const tokens: Partial<Record<ThemeToken, string>> = {};
  let unknownCount = 0;

  // Match declarations anywhere in the file: which selector they sit under is irrelevant,
  // because the output stylesheet is generated with our own selector regardless.
  const declaration = /(--[a-z0-9-]+)\s*:\s*((?:[^;{}"']|"[^"]*"|'[^']*')+)[;}]/gi;
  let match: RegExpExecArray | null;

  while ((match = declaration.exec(body)) !== null) {
    const prop = match[1].toLowerCase();
    const value = match[2].trim();

    if (!TOKEN_SET.has(prop)) {
      unknownCount++;
      continue;
    }
    if (!isValidValueForToken(prop as ThemeToken, value)) {
      warnings.push(`Ignored ${prop}: "${value.slice(0, 40)}" is not a valid value for that token.`);
      continue;
    }
    tokens[prop as ThemeToken] = value;
  }

  if (unknownCount > 0) {
    warnings.push(`Ignored ${unknownCount} propert${unknownCount === 1 ? 'y' : 'ies'} that are not theme tokens.`);
  }

  const count = Object.keys(tokens).length;
  if (count === 0) {
    errors.push(
      'No usable theme tokens were found. A theme file must set at least --bg, --surface, --text-primary and --accent.'
    );
    return { theme: null, errors, warnings };
  }

  // Without these four the result is unreadable rather than merely unusual.
  const essential: ThemeToken[] = ['--bg', '--surface', '--text-primary', '--accent'];
  const missing = essential.filter((t) => !tokens[t]);
  if (missing.length > 0) {
    warnings.push(`Missing ${missing.join(', ')} — the default palette fills these in.`);
  }

  return {
    theme: { id: themeIdFromName(name), name, author, description, scheme, tokens },
    errors,
    warnings,
  };
}

/**
 * Complete fallback palettes, mirroring the Emerald and Slate Light blocks in globals.css.
 *
 * A custom theme is resolved against one of these before it is applied, so a file that sets
 * only a handful of tokens still produces a coherent palette. Resolving in JS rather than
 * leaning on CSS cascade order matters for light themes: `:root` carries the dark default,
 * so an unresolved light theme would inherit dark borders and muted text.
 */
export const BASE_PALETTES: Record<'dark' | 'light', Record<ColorToken, string>> = {
  dark: {
    '--bg': '#0d1117',
    '--surface': '#161b22',
    '--surface-2': '#1c2333',
    '--border': '#21262d',
    '--border-2': '#30363d',
    '--text-primary': '#e6edf3',
    '--text-muted': '#8b949e',
    '--accent': '#00d97e',
    '--accent-dim': 'rgba(0, 217, 126, 0.1)',
    '--accent-border': 'rgba(0, 217, 126, 0.25)',
    '--on-accent': '#0d1117',
    '--warning': '#f0883e',
    '--danger': '#f85149',
    '--advanced': '#a78bfa',
    '--advanced-solid': '#8b5cf6',
    '--advanced-dim': 'rgba(139, 92, 246, 0.12)',
    '--advanced-border': 'rgba(139, 92, 246, 0.28)',
  },
  light: {
    '--bg': '#f4f6fa',
    '--surface': '#ffffff',
    '--surface-2': '#eef1f7',
    '--border': '#dee3ec',
    '--border-2': '#c8d0de',
    '--text-primary': '#161d2b',
    '--text-muted': '#5a6478',
    '--accent': '#0f9d58',
    '--accent-dim': 'rgba(15, 157, 88, 0.1)',
    '--accent-border': 'rgba(15, 157, 88, 0.3)',
    '--on-accent': '#ffffff',
    '--warning': '#b25d09',
    '--danger': '#c0392b',
    '--advanced': '#5b2fc4',
    '--advanced-solid': '#6d3fd4',
    '--advanced-dim': 'rgba(109, 63, 212, 0.1)',
    '--advanced-border': 'rgba(109, 63, 212, 0.28)',
  },
};

/** Fills a partial theme out to the complete token set. */
export function resolveThemeTokens(
  theme: CustomTheme
): Record<ColorToken, string> & Partial<Record<DecorationToken, string>> {
  return { ...BASE_PALETTES[theme.scheme], ...theme.tokens };
}

/**
 * Builds the stylesheet for a custom theme.
 *
 * Every value here has already passed `isValidTokenValue`, and the property names come
 * from our own allowlist rather than the file — so this string cannot contain anything the
 * uploader chose freely.
 */
export function buildThemeCss(theme: CustomTheme, selector = '[data-theme="custom"]'): string {
  const lines = THEME_TOKENS.filter((token) => theme.tokens[token]).map(
    (token) => `  ${token}: ${theme.tokens[token]};`
  );
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${lines.join('\n')}\n}`;
}

/** Writes a theme back out as a shareable file, round-tripping through the same parser. */
export function serializeTheme(theme: CustomTheme): string {
  const header = [
    '/*',
    ` * @name ${theme.name}`,
    theme.author ? ` * @author ${theme.author}` : null,
    theme.description ? ` * @description ${theme.description}` : null,
    ` * @scheme ${theme.scheme}`,
    ' *',
    ' * A CraftControl theme. Upload it under My account → Appearance.',
    ' * Only the tokens below are read; everything else in this file is ignored.',
    ' */',
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}\n\n${buildThemeCss(theme, ':root')}\n`;
}
