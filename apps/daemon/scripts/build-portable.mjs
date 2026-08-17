/*
 * Builds a portable, Docker-free node bundle for Linux — including Android/Termux.
 *
 * The Docker image is not an option everywhere. Android has no kernel support for
 * containers and no root to enable it with, and the same is true of any host where
 * installing Docker is more trouble than the node is worth. But the daemon does not
 * actually need Docker: ExecutionMode.PROCESS runs game servers as plain child
 * processes, which is how the Windows desktop node has always worked. What was
 * missing was a way to *get* the daemon onto such a machine.
 *
 * The result is a tarball holding the same bundled daemon the Windows installer
 * ships, plus frpc and a launcher. It carries no node_modules to install and no
 * build step to run on the target — which matters most on a phone, where npm
 * install under Termux is slow and the native-addon builds fail.
 *
 *   node scripts/build-portable.mjs [--arch=arm64|amd64] [--no-frpc]
 *
 * Run `npm run build:shared && npm run build:daemon` from the repo root first: this
 * bundles their compiled output rather than the TypeScript sources.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { bundleDaemon } from '../../daemon-desktop/scripts/bundle-daemon.mjs';
import { fetchFrpc } from './frp-download.mjs';
import { createTarGz } from './tar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.join(here, '..');
const repoRoot = path.join(daemonRoot, '..', '..');
const sharedRoot = path.join(repoRoot, 'packages', 'shared');

const args = process.argv.slice(2);
const archArg = args.find((a) => a.startsWith('--arch='))?.split('=')[1] ?? 'arm64';
const withFrpc = !args.includes('--no-frpc');

// Accept the names people actually type; frp and Node disagree about x64 vs amd64.
const ARCHES = { arm64: 'arm64', aarch64: 'arm64', amd64: 'amd64', x64: 'amd64', x86_64: 'amd64' };
const arch = ARCHES[archArg];
if (!arch) {
  console.error(`Unknown --arch=${archArg}. Use arm64 or amd64.`);
  process.exit(1);
}

function required(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(repoRoot, file)} — ${hint}`);
    process.exit(1);
  }
}

required(path.join(daemonRoot, 'dist', 'index.js'), 'run "npm run build:daemon" from the repo root first.');
required(path.join(sharedRoot, 'dist', 'index.js'), 'run "npm run build:shared" from the repo root first.');

const version = JSON.parse(fs.readFileSync(path.join(daemonRoot, 'package.json'), 'utf8')).version;
const work = path.join(daemonRoot, 'build', 'portable');
const root = 'mc-hosting-node';

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

/*
 * 1. The daemon and its dependencies as a single file. Shared with the Windows
 *    installer deliberately — the same bundle, built the same way, so a bug found on
 *    one platform is not a different bug on the other.
 */
const bundlePath = path.join(work, 'index.js');
await bundleDaemon(bundlePath);

/*
 * 2. node-unrar-js, kept whole: it loads its wasm relative to its own directory, so
 *    inlining the JS would orphan the binary. start.sh puts vendor/ on NODE_PATH.
 */
const unrarRoot = path.dirname(
  createRequire(path.join(daemonRoot, 'package.json')).resolve('node-unrar-js/package.json')
);

/*
 * 3. The tunnel client. Optional — a bundle built with --no-frpc still runs, and the
 *    daemon survives its absence — but a phone is usually behind carrier NAT, which
 *    is exactly the case the tunnel exists for.
 */
let frpcData = null;
if (withFrpc) {
  const cached = path.join(daemonRoot, 'build', 'frpc', `frpc-linux-${arch}`);
  await fetchFrpc({ platform: 'linux', arch, destFile: cached, requireDir: daemonRoot });
  frpcData = fs.readFileSync(cached);
}

/** Walks a directory into tar entries, rooted at `prefix`. */
function collect(dir, prefix, entries = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    // Tar paths are always forward-slashed, whatever the build host uses.
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) collect(full, name, entries);
    else if (item.isFile()) entries.push({ name, data: fs.readFileSync(full) });
  }
  return entries;
}

const entries = [
  { name: `${root}/index.js`, data: fs.readFileSync(bundlePath) },
  // The setup page: index.ts serves it from disk with express.static.
  ...collect(path.join(daemonRoot, 'src', 'public'), `${root}/public`),
  ...collect(unrarRoot, `${root}/vendor/node-unrar-js`),
  {
    // So Node reads the bundle as CommonJS instead of walking up out of the directory.
    name: `${root}/package.json`,
    data: Buffer.from(
      JSON.stringify(
        { name: 'mc-hosting-node', version, private: true, type: 'commonjs', main: 'index.js' },
        null,
        2
      ) + '\n'
    ),
  },
  { name: `${root}/start.sh`, data: fs.readFileSync(path.join(here, 'portable', 'start.sh')), mode: 0o755 },
  { name: `${root}/README.md`, data: fs.readFileSync(path.join(here, 'portable', 'README.md')) },
  ...(frpcData ? [{ name: `${root}/frpc`, data: frpcData, mode: 0o755 }] : []),
];

const outDir = path.join(daemonRoot, 'release');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `mc-hosting-node-${version}-linux-${arch}.tar.gz`);
fs.writeFileSync(outFile, createTarGz(entries));

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\nPortable node bundle: ${path.relative(repoRoot, outFile)} (${mb} MB, ${entries.length} files)`);
console.log(`  linux/${arch}${frpcData ? ' with frpc' : ' without frpc'}`);
