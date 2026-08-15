import { execFile } from 'child_process';
import type { DockerStatus } from '../shared-types';

/*
 * Every game server this node hosts is a Docker container, so Docker Desktop is a
 * hard prerequisite. The app reports its state rather than trying to install it —
 * the three outcomes below need genuinely different things from the user.
 */

const PROBE_TIMEOUT_MS = 8000;

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        // ENOENT means the docker CLI isn't on PATH at all.
        missing: code === 'ENOENT',
      });
    });
  });
}

export async function checkDocker(): Promise<DockerStatus> {
  const server = await run('docker', ['version', '--format', '{{.Server.Version}}']);

  if (server.ok && server.stdout) {
    return { state: 'ok', version: server.stdout, detail: `Docker Engine ${server.stdout} is running.` };
  }

  if (server.missing) {
    return {
      state: 'not-installed',
      version: null,
      detail: 'Docker Desktop was not found on this machine. The node cannot start servers without it.',
    };
  }

  // The CLI exists but could not reach the engine — almost always Docker Desktop
  // being installed but not started, which is a one-click fix rather than a download.
  return {
    state: 'not-running',
    version: null,
    detail: 'Docker is installed but the engine is not responding. Start Docker Desktop and check again.',
  };
}

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';
