import fs from 'fs';
import path from 'path';
import { parseThemeFile } from '@/lib/theme/theme-tokens';

/**
 * The theme files shipped with the panel.
 *
 * They live in `apps/web/themes`, deliberately NOT in `public/`: anything under `public/`
 * is served as a static asset with no authentication, so a panel exposed to the internet
 * would hand its theme files to anyone who asked. These are read from disk and served only
 * to a signed-in user.
 *
 * Themes a user uploads never reach the server at all — they are held in that browser's
 * localStorage — so this module covers the bundled files only.
 */

export interface BuiltinThemeSummary {
  /** File basename without the extension; the only thing accepted as a lookup key. */
  slug: string;
  name: string;
  description?: string;
  scheme: 'dark' | 'light';
  /** Swatch colours for the picker: [background, surface, accent]. */
  swatch: [string, string, string];
}

/**
 * `process.cwd()` is `apps/web` under both `npm run dev` and the container's start command,
 * which does `cd apps/web` before starting the server.
 */
function themesDir(): string {
  return path.join(process.cwd(), 'themes');
}

/** Rejects anything that is not a plain basename, so a slug can never walk the filesystem. */
function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(slug);
}

export function listBuiltinThemes(): BuiltinThemeSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(themesDir()).filter((f) => f.endsWith('.css'));
  } catch {
    // No bundled themes in this deployment is a perfectly valid state.
    return [];
  }

  const summaries: BuiltinThemeSummary[] = [];

  for (const file of files.sort()) {
    const slug = file.replace(/\.css$/i, '');
    if (!isSafeSlug(slug)) continue;

    const source = readBuiltinTheme(slug);
    if (!source) continue;

    // Parsing here rather than trusting the header means the picker shows what the file
    // will actually apply, and a malformed bundled file is skipped instead of shipped.
    const { theme } = parseThemeFile(source, slug);
    if (!theme) continue;

    const base = theme.scheme === 'light'
      ? { bg: '#f4f6fa', surface: '#eef1f7', accent: '#0f9d58' }
      : { bg: '#0d1117', surface: '#1c2333', accent: '#00d97e' };

    summaries.push({
      slug,
      name: theme.name,
      description: theme.description,
      scheme: theme.scheme,
      swatch: [
        theme.tokens['--bg'] || base.bg,
        theme.tokens['--surface-2'] || theme.tokens['--surface'] || base.surface,
        theme.tokens['--accent'] || base.accent,
      ],
    });
  }

  return summaries;
}

/** Returns the raw file, or null if the slug names nothing bundled. */
export function readBuiltinTheme(slug: string): string | null {
  if (!isSafeSlug(slug)) return null;

  const full = path.join(themesDir(), `${slug}.css`);
  // Belt and braces: confirm the resolved path really is inside the themes directory.
  if (path.dirname(path.resolve(full)) !== path.resolve(themesDir())) return null;

  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
