import './globals.css';
import type { Metadata } from 'next';
import { AuthProvider } from '@/context/AuthContext';
import { UIPrefsProvider } from '@/context/UIPrefsContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { ToastProvider } from '@/context/ToastContext';
import { ConfirmProvider } from '@/context/ConfirmContext';

export const metadata: Metadata = {
  title: 'CraftControl - Split Architecture Minecraft Server Manager',
  description: 'Control Plane Web Panel for managing remote Minecraft nodes and Modrinth modpacks',
};

/**
 * Runs before first paint, ahead of React hydration, so the saved palette is on <html>
 * by the time the stylesheet resolves. Doing this in a `useEffect` instead would paint
 * the default theme first and then flip — a visible flash on every page load.
 *
 * For a custom theme it reads the resolved token map the provider stored, rather than
 * re-parsing the uploaded file: the parser is far too large to inline here, and the values
 * were already validated when the theme was imported. Values are re-checked against a
 * colour pattern anyway, so anything that reached storage by another route is dropped.
 *
 * The built-in list is duplicated here on purpose — this string cannot import from
 * ThemeContext, and it must stay small. Keep it in step with THEMES.
 */
const THEME_BOOTSTRAP = `
(function () {
  var root = document.documentElement;
  var BUILT_IN = ['emerald', 'midnight', 'tokyo-night', 'catppuccin', 'dracula', 'rose-pine',
    'nord', 'gruvbox', 'cyberpunk', 'high-contrast', 'slate-light', 'solarized-light'];
  try {
    var t = localStorage.getItem('craftcontrol.theme') || 'emerald';

    if (t.indexOf('custom:') === 0) {
      var raw = localStorage.getItem('craftcontrol.theme.resolved');
      var data = raw ? JSON.parse(raw) : null;
      if (data && data.tokens) {
        var safe = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\\([0-9a-zA-Z.%,\\/\\s+-]+\\)|[a-zA-Z]+|[0-9.]+(px|em|rem|%|vw|vh)( [0-9.a-z%]+)?)$/;
        // Embedded artwork is allowed through so a decorated theme paints on first frame;
        // a data: URI reaches nothing off-box, and anything else is dropped.
        var img = /^url\\(\\s*["']?data:image\\//i;
        for (var k in data.tokens) {
          var v = String(data.tokens[k]).trim();
          if (k.indexOf('--') === 0 && (safe.test(v) || img.test(v))) {
            root.style.setProperty(k, String(data.tokens[k]).trim());
          }
        }
        root.style.setProperty('color-scheme', data.scheme === 'light' ? 'light' : 'dark');
        root.setAttribute('data-theme', 'custom');
        return;
      }
      t = 'emerald';
    }

    root.setAttribute('data-theme', BUILT_IN.indexOf(t) > -1 ? t : 'emerald');
  } catch (e) {
    root.setAttribute('data-theme', 'emerald');
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="emerald" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      {/* Colours come from the design tokens in globals.css — utility classes here would
          out-specify the `body` rule and desync the app background from the token. */}
      <body>
        <AuthProvider>
          <UIPrefsProvider>
            <ThemeProvider>
              <ToastProvider>
                <ConfirmProvider>{children}</ConfirmProvider>
              </ToastProvider>
            </ThemeProvider>
          </UIPrefsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
