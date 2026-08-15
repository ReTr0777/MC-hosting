'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  buildThemeCss,
  parseThemeFile,
  resolveThemeTokens,
  THEME_TOKENS,
  type CustomTheme,
  type ParseResult,
} from '@/lib/theme/theme-tokens';

/**
 * Theme selection.
 *
 * Built-in themes are complete palettes of the design tokens in globals.css, selected by a
 * `data-theme` attribute on <html>. Switching one is a single attribute write — no
 * re-render of the tree, no stylesheet swap.
 *
 * Custom themes are uploaded files, parsed and revalidated by `lib/theme-tokens`, then
 * applied through a generated stylesheet built from the validated values alone. Nothing
 * from an uploaded file is ever inserted into the document verbatim.
 *
 * The stored theme is applied by a blocking inline script in `layout.tsx` before first
 * paint; this provider mirrors that state into React. Doing the first write here would
 * flash the default palette on every load.
 */

export const THEME_STORAGE_KEY = 'craftcontrol.theme';
/** Uploaded themes, as an array of CustomTheme. */
export const CUSTOM_THEMES_KEY = 'craftcontrol.themes.custom';
/** The active custom theme's fully-resolved tokens, so the boot script needs no parser. */
export const RESOLVED_TOKENS_KEY = 'craftcontrol.theme.resolved';
export const DEFAULT_THEME = 'emerald';
export const CUSTOM_STYLE_ID = 'cc-custom-theme';

export interface ThemeDefinition {
  key: string;
  label: string;
  description: string;
  /** Swatch colours for the picker preview: [background, surface, accent]. */
  swatch: [string, string, string];
  dark: boolean;
  custom?: boolean;
}

/** Keep in step with the `[data-theme=...]` blocks in globals.css. */
export const THEMES: ThemeDefinition[] = [
  {
    key: 'emerald',
    label: 'Emerald',
    description: 'The CraftControl default — GitHub-dark greys with a green accent.',
    swatch: ['#0d1117', '#161b22', '#00d97e'],
    dark: true,
  },
  {
    key: 'midnight',
    label: 'Midnight',
    description: 'Near-black navy with a cool blue accent. The darkest of the set.',
    swatch: ['#05070f', '#131a2e', '#4f8cff'],
    dark: true,
  },
  {
    key: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Muted indigo with a soft blue accent. Easy on the eyes after dark.',
    swatch: ['#1a1b26', '#272b3f', '#7aa2f7'],
    dark: true,
  },
  {
    key: 'catppuccin',
    label: 'Catppuccin',
    description: 'Warm pastel mocha tones with a gentle green accent.',
    swatch: ['#1e1e2e', '#313244', '#a6e3a1'],
    dark: true,
  },
  {
    key: 'dracula',
    label: 'Dracula',
    description: 'The classic purple-on-slate editor palette.',
    swatch: ['#282a36', '#3d4152', '#bd93f9'],
    dark: true,
  },
  {
    key: 'rose-pine',
    label: 'Rosé Pine',
    description: 'Low-contrast plum and pine with a dusty cyan accent.',
    swatch: ['#191724', '#26233a', '#9ccfd8'],
    dark: true,
  },
  {
    key: 'nord',
    label: 'Nord',
    description: 'Muted arctic blue-greys. Low contrast, easy on long sessions.',
    swatch: ['#2e3440', '#3b4252', '#88c0d0'],
    dark: true,
  },
  {
    key: 'gruvbox',
    label: 'Gruvbox',
    description: 'Retro warm browns with a mustard-green accent.',
    swatch: ['#1d2021', '#32302f', '#b8bb26'],
    dark: true,
  },
  {
    key: 'cyberpunk',
    label: 'Cyberpunk',
    description: 'Deep violet with a high-voltage cyan accent.',
    swatch: ['#0a0714', '#1d1435', '#00f0ff'],
    dark: true,
  },
  {
    key: 'high-contrast',
    label: 'High Contrast',
    description: 'Pure black with maximum-contrast text, for low vision and bright rooms.',
    swatch: ['#000000', '#161616', '#00ff9c'],
    dark: true,
  },
  {
    key: 'slate-light',
    label: 'Slate Light',
    description: 'Clean neutral light theme for bright rooms and projectors.',
    swatch: ['#f4f6fa', '#eef1f7', '#0f9d58'],
    dark: false,
  },
  {
    key: 'solarized-light',
    label: 'Solarized Light',
    description: 'The warm cream Solarized palette with a blue accent.',
    swatch: ['#fdf6e3', '#f2ebd7', '#268bd2'],
    dark: false,
  },
];

// Deliberately not a type predicate: narrowing `string | null` down to `never` in the
// alternate branch of an `||` is exactly wrong when the other branch still needs the value.
export function isBuiltInTheme(value: unknown): boolean {
  return typeof value === 'string' && THEMES.some((t) => t.key === value);
}

export function customThemeKey(id: string): string {
  return `custom:${id}`;
}

interface ThemeContextType {
  theme: string;
  setTheme: (theme: string) => void;
  /** Applies a theme to the DOM without persisting it — used for hover previews. */
  previewTheme: (theme: string | null) => void;
  themes: ThemeDefinition[];
  customThemes: CustomTheme[];
  /** Parses, validates and stores an uploaded theme file. Returns what the parser found. */
  importTheme: (source: string, fallbackName?: string) => ParseResult;
  removeCustomTheme: (id: string) => void;
  /** False until stored preferences have been read on the client. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  previewTheme: () => {},
  themes: THEMES,
  customThemes: [],
  importTheme: () => ({ theme: null, errors: ['Theme provider is not mounted.'], warnings: [] }),
  removeCustomTheme: () => {},
  ready: false,
});

/** Writes the generated stylesheet for a custom theme, replacing any previous one. */
function applyCustomCss(theme: CustomTheme) {
  // `:root[data-theme]` out-specifies the plain `[data-theme]` blocks in globals.css, so a
  // custom theme always wins regardless of stylesheet order.
  const resolved: CustomTheme = { ...theme, tokens: resolveThemeTokens(theme) };
  const css = buildThemeCss(resolved, ':root[data-theme="custom"]');

  let style = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/**
 * Drops the inline token values the pre-paint boot script writes.
 *
 * That script has to use inline styles — it runs before any stylesheet of ours exists — but
 * inline styles beat every rule in a stylesheet. Left in place they would pin the page to
 * the booted custom palette and make every later theme switch a no-op.
 */
function clearInlineTokens() {
  const style = document.documentElement.style;
  THEME_TOKENS.forEach((token) => style.removeProperty(token));
  style.removeProperty('color-scheme');
}

function applyToDom(themeKey: string, customThemes: CustomTheme[]) {
  clearInlineTokens();

  if (themeKey.startsWith('custom:')) {
    const id = themeKey.slice('custom:'.length);
    const custom = customThemes.find((t) => t.id === id);
    if (custom) {
      applyCustomCss(custom);
      document.documentElement.setAttribute('data-theme', 'custom');
      return;
    }
    // The theme was deleted out from under the selection — fall back rather than render
    // an attribute with no matching rules.
    document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
    return;
  }
  document.documentElement.setAttribute('data-theme', isBuiltInTheme(themeKey) ? themeKey : DEFAULT_THEME);
}

function readCustomThemes(): CustomTheme[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEMES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Server-render with the default so markup matches; the inline script has already painted
  // the real theme by the time this hydrates, and the effect below syncs state.
  const [theme, setThemeState] = useState<string>(DEFAULT_THEME);
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [ready, setReady] = useState(false);
  /** Guards the first upload: nothing is pushed before the account has been read. */
  const accountLoaded = useRef(false);

  useEffect(() => {
    const custom = readCustomThemes();
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Private-mode / blocked storage: the default theme is a fine fallback.
    }

    const valid =
      isBuiltInTheme(stored) ||
      (typeof stored === 'string' && stored.startsWith('custom:') && custom.some((t) => customThemeKey(t.id) === stored));
    const initial = valid ? (stored as string) : DEFAULT_THEME;

    setCustomThemes(custom);
    setThemeState(initial);
    applyToDom(initial, custom);
    setReady(true);

    // Then reconcile with the account, which is what makes a theme chosen on one
    // device show up on the next.
    let cancelled = false;
    (async () => {
      let account: { themeKey: string | null; customThemes: CustomTheme[] | null } | null = null;
      try {
        const res = await fetch('/api/account/theme');
        if (res.ok) account = await res.json();
      } catch {
        // Signed out or offline: local storage is still authoritative for this session.
      }
      if (cancelled) return;

      // Both fields null means the account has never saved an appearance. Adopt whatever
      // this browser already had rather than resetting a user who themed before this
      // existed — this is the one-time migration off localStorage.
      if (!account || (account.themeKey === null && account.customThemes === null)) {
        accountLoaded.current = true;
        if (account) syncToAccount(initial, custom);
        return;
      }

      // Otherwise the account wins, so that deleting a theme on one device does not have
      // it reappear from another. localStorage becomes a cache of that answer.
      const serverThemes = Array.isArray(account.customThemes) ? account.customThemes : [];
      const serverKey =
        account.themeKey &&
        (isBuiltInTheme(account.themeKey) ||
          serverThemes.some((t) => customThemeKey(t.id) === account.themeKey))
          ? account.themeKey
          : DEFAULT_THEME;

      accountLoaded.current = true;

      const sameThemes = JSON.stringify(serverThemes) === JSON.stringify(custom);
      if (sameThemes && serverKey === initial) return;

      setCustomThemes(serverThemes);
      setThemeState(serverKey);
      applyToDom(serverKey, serverThemes);
      persistResolved(serverKey, serverThemes);
      try {
        window.localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(serverThemes));
        window.localStorage.setItem(THEME_STORAGE_KEY, serverKey);
      } catch {
        // Only costs the pre-paint fast path on the next load.
      }
    })();

    return () => { cancelled = true; };
    // Runs once on mount; the helpers it calls are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Pushes the current appearance to the account, so the next device picks it up.
   *
   * Deliberately fire-and-forget: localStorage has already been written by the time
   * this runs, so a failed sync costs cross-device carry-over and nothing else. It is
   * skipped entirely until the account has been read once, or the very first render
   * would upload the default theme over whatever the account already had.
   */
  const syncToAccount = useCallback((themeKey: string, pool: CustomTheme[]) => {
    if (!accountLoaded.current) return;
    fetch('/api/account/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeKey, customThemes: pool }),
    }).catch(() => {
      /* Offline, signed out, or storage full — the local selection still stands. */
    });
  }, []);

  /** Persists the resolved tokens so the pre-paint boot script can apply them without a parser. */
  const persistResolved = useCallback((themeKey: string, pool: CustomTheme[]) => {
    try {
      if (!themeKey.startsWith('custom:')) {
        window.localStorage.removeItem(RESOLVED_TOKENS_KEY);
        return;
      }
      const custom = pool.find((t) => customThemeKey(t.id) === themeKey);
      if (!custom) return;
      window.localStorage.setItem(
        RESOLVED_TOKENS_KEY,
        JSON.stringify({ scheme: custom.scheme, tokens: resolveThemeTokens(custom) })
      );
    } catch {
      // Only costs a flash of the default palette on the next load.
    }
  }, []);

  const setTheme = useCallback(
    (next: string) => {
      const isCustom = next.startsWith('custom:') && customThemes.some((t) => customThemeKey(t.id) === next);
      if (!isBuiltInTheme(next) && !isCustom) return;

      setThemeState(next);
      applyToDom(next, customThemes);
      persistResolved(next, customThemes);
      syncToAccount(next, customThemes);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Selection just won't survive a reload.
      }
    },
    [customThemes, persistResolved]
  );

  // Passing null reverts to the committed theme, so a cancelled hover leaves no trace.
  const previewTheme = useCallback(
    (next: string | null) => {
      applyToDom(next === null ? theme : next, customThemes);
    },
    [theme, customThemes]
  );

  const importTheme = useCallback(
    (source: string, fallbackName?: string): ParseResult => {
      const result = parseThemeFile(source, fallbackName);
      if (!result.theme) return result;

      // Re-importing a theme with the same name replaces it rather than accumulating copies.
      const next = [...customThemes.filter((t) => t.id !== result.theme!.id), result.theme];
      setCustomThemes(next);
      try {
        window.localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      } catch {
        result.warnings.push('The theme could not be saved to this browser, so it will be gone after a reload.');
      }

      const key = customThemeKey(result.theme.id);
      setThemeState(key);
      applyToDom(key, next);
      persistResolved(key, next);
      syncToAccount(key, next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, key);
      } catch {
        /* handled above */
      }

      return result;
    },
    [customThemes, persistResolved]
  );

  const removeCustomTheme = useCallback(
    (id: string) => {
      const next = customThemes.filter((t) => t.id !== id);
      setCustomThemes(next);
      // Synced even when the deleted theme was not the active one, or it would come
      // back the next time another device pushed its copy.
      syncToAccount(theme === customThemeKey(id) ? DEFAULT_THEME : theme, next);
      try {
        window.localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      } catch {
        // Nothing useful to do; the in-memory list is already updated.
      }

      // Deleting the theme currently in use has to move the user somewhere valid.
      if (theme === customThemeKey(id)) {
        setThemeState(DEFAULT_THEME);
        applyToDom(DEFAULT_THEME, next);
        persistResolved(DEFAULT_THEME, next);
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, DEFAULT_THEME);
        } catch {
          /* best effort */
        }
      }
    },
    [customThemes, theme, persistResolved]
  );

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, previewTheme, themes: THEMES, customThemes, importTheme, removeCustomTheme, ready }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
