/*
 * Fetches the frpc tunnel client for a given platform and architecture.
 *
 * The daemon spawns frpc to expose game servers without port forwarding. Where it
 * comes from depends on how the node was installed: the Docker image installs it on
 * PATH, the Windows installer ships a copy beside app.asar, and the portable bundle
 * carries one in its own directory. All three want the same release, verified the
 * same way, so the download lives here and the callers say which build they need.
 *
 * The archive is checked against the checksums file published with the release, so a
 * corrupted or substituted download fails the build rather than shipping.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { extractFromTarGz } from './tar.mjs';

/*
 * Keep in step with apps/daemon/Dockerfile: both ends of a tunnel should be the same
 * frp release, and the daemon's config format is version-sensitive.
 */
export const FRP_VERSION = '0.58.0';

const BASE = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

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

/**
 * Downloads frpc and writes it to `destFile`, or returns the existing path if one is
 * already there — it changes only when FRP_VERSION does, and re-fetching 12 MB on
 * every build is a waste.
 *
 * `platform` is frp's naming: windows, linux, darwin. `arch` likewise: amd64, arm64.
 */
export async function fetchFrpc({ platform, arch, destFile, requireDir }) {
  if (fs.existsSync(destFile)) return destFile;

  const isWindows = platform === 'windows';
  const archive = `frp_${FRP_VERSION}_${platform}_${arch}.${isWindows ? 'zip' : 'tar.gz'}`;
  const binary = isWindows ? 'frpc.exe' : 'frpc';

  console.log(`Downloading frpc ${FRP_VERSION} for ${platform}/${arch}...`);
  const [archiveBuf, checksums] = await Promise.all([
    download(`${BASE}/${archive}`),
    download(`${BASE}/frp_sha256_checksums.txt`),
  ]);

  const want = expectedSha(checksums.toString('utf8'), archive);
  const got = crypto.createHash('sha256').update(archiveBuf).digest('hex');
  if (got !== want) {
    throw new Error(`Checksum mismatch for ${archive}.\n  expected ${want}\n  got      ${got}`);
  }

  let data;
  if (isWindows) {
    // adm-zip is the daemon's own dependency, hoisted to the workspace root. This is
    // a build script, so reaching for it costs the shipped app nothing.
    const AdmZip = createRequire(path.join(requireDir, 'package.json'))('adm-zip');
    const entry = new AdmZip(archiveBuf).getEntries().find((e) => e.entryName.endsWith(`/${binary}`));
    if (!entry) throw new Error(`No ${binary} inside ${archive}`);
    data = entry.getData();
  } else {
    data = extractFromTarGz(archiveBuf, (name) => name.endsWith(`/${binary}`));
    if (!data) throw new Error(`No ${binary} inside ${archive}`);
  }

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, data);
  // Meaningless on Windows and harmless there; on Linux the file is useless without it.
  fs.chmodSync(destFile, 0o755);

  console.log(`frpc ${FRP_VERSION} verified (sha256 ${got.slice(0, 12)}…) and cached`);
  return destFile;
}
