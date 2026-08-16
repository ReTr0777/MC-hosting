/*
 * Fetches the frpc tunnel client for the installer to ship.
 *
 * The daemon spawns frpc to expose game servers without port forwarding. The Docker
 * image installs it on PATH (apps/daemon/Dockerfile pins the same version); a Windows
 * machine has nothing of the sort, so the app carries its own copy and points
 * FRPC_PATH at it. Without this a node hoster who filled in the tunnel fields got no
 * tunnel at all.
 *
 * The download is verified against the checksums file published with the release, so
 * a corrupted or substituted archive fails the build rather than shipping.
 *
 * Cached in build/frpc/: it changes only when FRP_VERSION does, and re-downloading
 * 12 MB on every build is a waste.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Keep in step with apps/daemon/Dockerfile: both ends of a tunnel should be the same
// frp release, and the daemon's config format is version-sensitive.
const FRP_VERSION = '0.58.0';
const ARCHIVE = `frp_${FRP_VERSION}_windows_amd64.zip`;
const BASE = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const cacheDir = path.join(appRoot, 'build', 'frpc');
const exePath = path.join(cacheDir, 'frpc.exe');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The published checksums file is a plain "<sha256>  <filename>" table. */
function expectedSha(listing, filename) {
  for (const line of listing.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === filename) return sha;
  }
  throw new Error(`${filename} is not listed in the release checksums`);
}

export async function fetchFrpc() {
  if (fs.existsSync(exePath)) return exePath;

  console.log(`Downloading frpc ${FRP_VERSION}...`);
  const [zip, checksums] = await Promise.all([
    download(`${BASE}/${ARCHIVE}`),
    download(`${BASE}/frp_sha256_checksums.txt`),
  ]);

  const want = expectedSha(checksums.toString('utf8'), ARCHIVE);
  const got = crypto.createHash('sha256').update(zip).digest('hex');
  if (got !== want) {
    throw new Error(`Checksum mismatch for ${ARCHIVE}.\n  expected ${want}\n  got      ${got}`);
  }

  // adm-zip is the daemon's own dependency, hoisted to the workspace root. This is a
  // build script, so reaching for it costs the shipped app nothing.
  const AdmZip = createRequire(path.join(appRoot, 'package.json'))('adm-zip');
  const entry = new AdmZip(zip).getEntries().find((e) => e.entryName.endsWith('/frpc.exe'));
  if (!entry) throw new Error(`No frpc.exe inside ${ARCHIVE}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(exePath, entry.getData());
  console.log(`frpc ${FRP_VERSION} verified (sha256 ${got.slice(0, 12)}…) and cached`);
  return exePath;
}

// Runnable on its own for a cold cache, and imported by stage-daemon.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchFrpc();
}
