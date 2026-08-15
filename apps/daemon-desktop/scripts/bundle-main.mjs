/*
 * Bundles the main and preload processes with esbuild.
 *
 * tsc alone would emit `require('electron-updater')` and leave resolution to
 * runtime — but npm workspaces hoist that package to the repo-root node_modules,
 * which is not inside the packaged app. Rather than teach electron-builder about
 * the hoisting (or hand-copy a transitive dependency tree), everything except
 * Electron itself is inlined here, so dist/ is self-contained.
 *
 * Type checking is not esbuild's job: `npm run typecheck` runs tsc separately.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron is provided by the runtime; bundling it would be wrong and enormous.
  external: ['electron'],
  // Matches the Node that ships inside Electron 33.
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src', 'main', 'index.ts')],
  outfile: path.join(root, 'dist', 'main', 'index.js'),
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src', 'preload', 'index.ts')],
  outfile: path.join(root, 'dist', 'preload', 'index.js'),
});

console.log('main + preload bundled to dist/');
