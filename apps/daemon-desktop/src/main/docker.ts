import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { DockerStatus } from '../shared-types';

/*
 * Every game server this node hosts is a Docker container, so Docker Desktop is a
 * hard prerequisite. The app reports its state, starts it when asked, and installs
 * nothing — the three outcomes below need genuinely different things from the user.
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

/**
 * Where Docker Desktop's executable lives, or null if this machine has no copy.
 *
 * The docker CLI being on PATH says nothing about where the desktop application is — the
 * CLI is a separate shim, and starting the engine means starting the app. These are the
 * two locations its installer uses; per-user installs land in the second.
 */
export function dockerDesktopPath(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Docker', 'Docker Desktop.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable path is not the one we are looking for.
    }
  }
  return null;
}

/**
 * Launches Docker Desktop and leaves it running.
 *
 * Detached and unref'd on purpose: Docker must outlive this app, not die with it. A node
 * hoster who quits the tray icon should not take their containers down with them.
 */
export function startDockerDesktop(): { started: boolean; detail: string } {
  const exe = dockerDesktopPath();
  if (!exe) {
    return {
      started: false,
      detail: 'Docker Desktop is not installed on this machine, so there is nothing to start.',
    };
  }

  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { started: true, detail: 'Starting Docker Desktop…' };
  } catch (err: any) {
    return { started: false, detail: `Docker Desktop could not be launched: ${err.message}` };
  }
}

/** How long Docker gets to come up. Cold starts on a spinning disk genuinely take minutes. */
const ENGINE_WAIT_MS = 4 * 60_000;
const ENGINE_POLL_MS = 4000;

/**
 * Waits for the engine to answer after a launch.
 *
 * Docker Desktop returns from spawn long before the engine accepts connections — the VM
 * has to boot first. Without this the app would report "not running" seconds after
 * starting it and invite the user to start it again.
 */
export async function waitForDockerEngine(
  onProgress?: (status: DockerStatus) => void,
  timeoutMs = ENGINE_WAIT_MS
): Promise<DockerStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await checkDocker();
    if (status.state === 'ok') return status;

    onProgress?.({
      state: 'starting',
      version: null,
      detail: 'Waiting for the Docker engine to finish starting…',
    });
    await new Promise((r) => setTimeout(r, ENGINE_POLL_MS));
  }

  return {
    state: 'not-running',
    version: null,
    detail:
      'Docker Desktop was started but the engine did not come up within four minutes. ' +
      'Open Docker Desktop and see what it is waiting for.',
  };
}

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';
