import fs from 'fs';
import path from 'path';
import { CreateServerContainerDto, ExecutionMode } from '@mc-manager/shared';
import { processManager } from './process';
import { startServerContainer, stopServerContainer } from './docker';
import { loadConfig } from '../config';

const config = loadConfig();

/**
 * Starting and stopping a server used to live only inside the HTTP route handlers.
 * The sleep listener has to wake a server without going through HTTP, so the logic
 * lives here and both callers share it.
 *
 * A "target" is whatever the panel stored as containerId: either `process-<id>`
 * for native mode or `mc-server-<id>` / a raw container id for Docker mode.
 */

export function isProcessTarget(target: string): boolean {
  return target.startsWith('process-');
}

/** Strips the mode prefix to get the plain server id used for data directories. */
export function bareServerId(target: string): string {
  return target.replace('process-', '').replace('mc-server-', '');
}

export function readMeta(serverId: string): Partial<CreateServerContainerDto> {
  const metaPath = path.join(config.dataDir, serverId, 'craftcontrol-meta.json');
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return {};
  }
}

/** The port the Minecraft server itself listens on, as recorded at creation time. */
export function serverPortFor(serverId: string): number | null {
  const meta = readMeta(serverId);
  const port = Number(meta.serverPort);
  return Number.isFinite(port) && port > 0 ? port : null;
}

export async function startTarget(target: string, overrides: Record<string, any> = {}): Promise<void> {
  const serverId = bareServerId(target);

  if (isProcessTarget(target)) {
    const defaults = {
      serverType: 'FABRIC' as any,
      mcVersion: '1.20.1',
      serverPort: 25565,
      memoryMb: 2048,
      cpuLimit: 1,
      eulaAccepted: true,
      executionMode: ExecutionMode.PROCESS,
    };

    // Saved metadata wins over defaults, explicit overrides win over both, but the
    // server id is never negotiable — it names the data directory.
    const dto = {
      ...defaults,
      ...readMeta(serverId),
      ...overrides,
      serverId,
    } as CreateServerContainerDto;

    await processManager.startProcess(dto);
    return;
  }

  await startServerContainer(target);
}

export async function stopTarget(target: string): Promise<void> {
  if (isProcessTarget(target)) {
    await processManager.stopProcess(bareServerId(target));
    return;
  }
  await stopServerContainer(target);
}
