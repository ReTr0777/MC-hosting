/*
 * Builds a self-contained copy of the daemon for the installer to ship.
 *
 * The result is one bundled index.js plus the few things that cannot be inlined —
 * see bundle-daemon.mjs for why it is a bundle and not the real dependency tree.
 * The whole directory is packed into app.asar by electron-builder.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { bundleDaemon } from './bundle-daemon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..', '..');
const daemonRoot = path.join(repoRoot, 'apps', 'daemon');
const sharedRoot = path.join(repoRoot, 'packages', 'shared');

/*
 * Not under build/: that is electron-builder's buildResources directory, which it
 * deliberately keeps out of the app package. This tree has to be packable.
 */
const stage = path.join(appRoot, 'daemon-runtime');

function required(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(repoRoot, file)} — ${hint}`);
    process.exit(1);
  }
}

required(path.join(daemonRoot, 'dist', 'index.js'), 'run "npm run build:daemon" from the repo root first.');
required(path.join(sharedRoot, 'dist', 'index.js'), 'run "npm run build:shared" from the repo root first.');

// Windows holds a lock on a directory that is any process's working directory, and
// briefly after an antivirus scan. Retrying beats failing the whole build.
try {
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch (err) {
  console.error(
    `Could not clear ${path.relative(repoRoot, stage)} (${err.code}).\n` +
      'Something is still using it — a running daemon started from that folder is the usual cause.'
  );
  process.exit(1);
}
fs.mkdirSync(stage, { recursive: true });

// 1. The daemon itself, dependencies and the workspace-linked shared package
//    inlined. @mc-manager/shared needs no special handling here: esbuild follows
//    the workspace symlink like any other import.
await bundleDaemon(path.join(stage, 'index.js'));

// 2. The setup page, which the bundle cannot contain — index.ts serves it off disk
//    with express.static(path.join(__dirname, 'public')). Reading it back out of
//    the asar works; Electron patches fs for that.
fs.cpSync(path.join(daemonRoot, 'src', 'public'), path.join(stage, 'public'), { recursive: true });

/*
 * 3. node-unrar-js, kept whole because its wasm is loaded relative to the package's
 *    own directory. It sits under vendor/ rather than node_modules/ because
 *    electron-builder strips every node_modules it finds; the daemon process is
 *    given NODE_PATH pointing here so the bare require still resolves.
 */
const unrar = path.dirname(
  createRequire(path.join(daemonRoot, 'package.json')).resolve('node-unrar-js/package.json')
);
fs.cpSync(unrar, path.join(stage, 'vendor', 'node-unrar-js'), { recursive: true });

/*
 * 4. A package.json so Node reads this directory as CommonJS. Without one it walks
 *    up to the desktop app's manifest, which happens to agree today — this makes it
 *    not depend on that.
 */
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'mc-hosting-daemon-runtime', version: '1.0.0', private: true, type: 'commonjs', main: 'index.js' }, null, 2)
);

console.log(`Daemon staged at ${path.relative(repoRoot, stage)}`);
