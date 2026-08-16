/*
 * Bundles the daemon into a single CommonJS file for the installer to ship.
 *
 * Why a bundle rather than the real dependency tree:
 *
 * electron-builder resolves node_modules itself, from the *app's* declared
 * dependencies, and strips every node_modules directory that a `files` glob would
 * otherwise have picked up. A staged tree therefore cannot be packed into app.asar,
 * and shipping it beside the archive as extraResources — which is what this used to
 * do — puts ~7000 loose files in the install directory. Auto-updates restored the
 * shallow ones and dropped node_modules entirely, so updated nodes started and
 * immediately died on "Cannot find module 'express'".
 *
 * One file inside app.asar has neither problem: nothing to resolve at runtime, and
 * the archive is replaced whole or not at all.
 *
 * Type checking is not esbuild's job; the daemon's own build ran tsc already. This
 * bundles the compiled dist/, not the TypeScript sources.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..', '..');
const daemonRoot = path.join(repoRoot, 'apps', 'daemon');

/*
 * Left out of the bundle on purpose:
 *
 * - *.node / cpu-features: native addons cannot be inlined, and cannot be loaded
 *   from inside an asar either. ssh2 (reached through dockerode) probes both in a
 *   try/catch and falls back to its pure-JS implementations, so leaving them
 *   unresolvable costs a little SSH throughput and nothing else. A desktop node
 *   talks to Docker over a local socket regardless.
 *
 * - @prisma/client / prisma: only touched when DATABASE_URL is set, which a desktop
 *   node never sets, and both call sites already tolerate the require throwing.
 *   Inlining it would drag the query engines — well over 100 MB — into the installer.
 *
 * - node-unrar-js: an Emscripten module that reads unrar.wasm from its own
 *   __dirname. Bundling it would inline the JS and orphan the .wasm, so it travels
 *   as a real package under vendor/ instead (see stage-daemon.mjs).
 */
export const EXTERNAL = ['*.node', 'cpu-features', '@prisma/client', 'prisma', 'node-unrar-js'];

export async function bundleDaemon(outfile) {
  const result = await esbuild.build({
    entryPoints: [path.join(daemonRoot, 'dist', 'index.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Matches the Node that ships inside Electron 33, which is what runs this file.
    target: 'node20',
    external: EXTERNAL,
    sourcemap: false,
    logLevel: 'warning',
    metafile: true,
  });

  const bytes = fs.statSync(outfile).size;
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(`Daemon bundled: ${inputs} modules -> ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}
