/*
 * Builds a self-contained copy of the daemon for the installer to ship.
 *
 * The repo is an npm workspace, so the daemon's dependencies are hoisted to the
 * root node_modules and there is no single folder electron-builder could copy.
 * Rather than teach the packager about the hoisting, we stage a plain directory
 * with its own package.json and let npm install the real tree — which also gets
 * the correct platform binaries for any native dependency.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..', '..');
const daemonRoot = path.join(repoRoot, 'apps', 'daemon');
const sharedRoot = path.join(repoRoot, 'packages', 'shared');
const stage = path.join(appRoot, 'build', 'daemon');

/*
 * Prisma is deliberately dropped. The daemon only touches the database when
 * DATABASE_URL is set, both call sites load it lazily and tolerate its absence,
 * and bundling its native query engines would add well over 100 MB to the
 * installer for a code path a desktop node never takes.
 */
const OMIT = new Set(['@mc-manager/shared', '@prisma/client', 'prisma']);

function required(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(repoRoot, file)} — ${hint}`);
    process.exit(1);
  }
}

required(path.join(daemonRoot, 'dist', 'index.js'), 'run "npm run build:daemon" from the repo root first.');
required(path.join(sharedRoot, 'dist', 'index.js'), 'run "npm run build:shared" from the repo root first.');

/*
 * The install happens in a temp directory *outside* the repository, then the result
 * is copied back in.
 *
 * npm resolves the workspace root by walking up for a package.json with a
 * "workspaces" field. Installing anywhere under apps/ therefore makes npm treat the
 * whole monorepo as the install target, and `--omit=dev` there prunes every
 * devDependency from the root node_modules — electron and electron-builder included.
 * Staying outside the tree is the only reliable way to keep this install isolated.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mch-daemon-stage-'));

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
fs.mkdirSync(path.dirname(stage), { recursive: true });

// 1. Compiled daemon.
fs.cpSync(path.join(daemonRoot, 'dist'), work, { recursive: true });

// 2. The setup page, which tsc does not emit (index.ts serves it from ./public).
fs.cpSync(path.join(daemonRoot, 'src', 'public'), path.join(work, 'public'), { recursive: true });

// 3. A manifest describing only what the daemon actually needs at runtime.
const daemonPkg = JSON.parse(fs.readFileSync(path.join(daemonRoot, 'package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries(daemonPkg.dependencies ?? {}).filter(([name]) => !OMIT.has(name))
);
fs.writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify({ name: 'mc-hosting-daemon-runtime', version: daemonPkg.version, private: true, main: 'index.js', dependencies }, null, 2)
);

// 4. Resolve that manifest into a real node_modules tree.
console.log('Installing daemon runtime dependencies (this takes a minute)...');

/*
 * Run npm's JS entry point under the current Node rather than the `npm` shim:
 * Node 18.20+/20.12+/22+ refuse to spawn .cmd files without shell:true, and going
 * through a shell would mean quoting arguments by hand.
 *
 * The npm_* variables are stripped because this script itself runs inside
 * `npm run stage`. Inheriting them re-applies the parent's workspace context to a
 * child install that is deliberately meant to be standalone.
 */
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')));
const npmCli = process.env.npm_execpath;
const installArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];

if (npmCli && npmCli.endsWith('.js')) {
  execFileSync(process.execPath, [npmCli, ...installArgs], { cwd: work, stdio: 'inherit', env });
} else {
  execFileSync('npm', installArgs, { cwd: work, stdio: 'inherit', env, shell: true });
}

// 5. Drop the workspace-linked shared package in by hand; npm cannot fetch it.
const sharedTarget = path.join(work, 'node_modules', '@mc-manager', 'shared');
fs.mkdirSync(sharedTarget, { recursive: true });
fs.cpSync(path.join(sharedRoot, 'dist'), path.join(sharedTarget, 'dist'), { recursive: true });
fs.copyFileSync(path.join(sharedRoot, 'package.json'), path.join(sharedTarget, 'package.json'));

// 6. Move the finished tree into place, then clean up the scratch directory.
fs.cpSync(work, stage, { recursive: true });
fs.rmSync(work, { recursive: true, force: true });

console.log(`Daemon staged at ${path.relative(repoRoot, stage)}`);
