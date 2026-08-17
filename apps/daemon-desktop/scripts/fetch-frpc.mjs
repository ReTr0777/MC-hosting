/*
 * Fetches the Windows frpc build for the installer to ship.
 *
 * The download, checksum verification and caching all live in the daemon's
 * frp-download.mjs — the Docker image, this installer and the portable Linux bundle
 * should never drift onto different frp releases, and the way to guarantee that is
 * for them to share the code that names the version.
 *
 * electron-builder picks the result up from build/frpc as an extraResource; it
 * cannot travel inside app.asar, because Windows cannot execute a binary that only
 * exists inside an archive.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchFrpc as fetchFrpcFor } from '../../daemon/scripts/frp-download.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const exePath = path.join(appRoot, 'build', 'frpc', 'frpc.exe');

export async function fetchFrpc() {
  return fetchFrpcFor({
    platform: 'windows',
    arch: 'amd64',
    destFile: exePath,
    requireDir: appRoot,
  });
}

// Runnable on its own for a cold cache, and imported by stage-daemon.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchFrpc();
}
