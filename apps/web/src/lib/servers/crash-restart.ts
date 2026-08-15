import { DaemonClient } from '@/lib/services/daemon-client';
import { ServerType } from '@mc-manager/shared';

/**
 * Panel-side helpers for crash auto-restart.
 *
 * A server is only restarted if `autoRestartEnabled` and it hasn't crashed more than
 * `MAX_ATTEMPTS` times within the trailing `CRASH_WINDOW_MS` window — past that it's
 * considered a crash loop and left in ERROR until a human intervenes.
 */

const CRASH_WINDOW_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 15_000;

export interface CrashRestartState {
  autoRestartEnabled: boolean;
  crashCount: number;
  crashWindowStartedAt: Date | null;
  lastCrashAt: Date | null;
}

export type CrashRestartVerdict =
  | { action: 'disabled' }
  | { action: 'loop'; crashCount: number; crashWindowStartedAt: Date }
  | { action: 'backoff'; crashCount: number; crashWindowStartedAt: Date; retryAfterMs: number }
  | { action: 'restart'; crashCount: number; crashWindowStartedAt: Date };

export function evaluateCrashRestart(input: CrashRestartState & { now?: Date }): CrashRestartVerdict {
  if (!input.autoRestartEnabled) return { action: 'disabled' };

  const now = input.now || new Date();
  const windowExpired =
    !input.crashWindowStartedAt || now.getTime() - input.crashWindowStartedAt.getTime() > CRASH_WINDOW_MS;

  const crashWindowStartedAt = windowExpired ? now : input.crashWindowStartedAt!;
  const crashCount = (windowExpired ? 0 : input.crashCount) + 1;

  if (crashCount > MAX_ATTEMPTS) {
    return { action: 'loop', crashCount, crashWindowStartedAt };
  }

  const backoffMs = BASE_BACKOFF_MS * Math.pow(2, crashCount - 1);
  const readyAt = input.lastCrashAt ? input.lastCrashAt.getTime() + backoffMs : 0;

  if (now.getTime() < readyAt) {
    return { action: 'backoff', crashCount, crashWindowStartedAt, retryAfterMs: readyAt - now.getTime() };
  }

  return { action: 'restart', crashCount, crashWindowStartedAt };
}

export interface NodeRef {
  host: string;
  port: number;
  apiKey: string;
}

export interface RestartableServer {
  id: string;
  containerId: string | null;
  /** Absent means Minecraft. Carried so a restart cannot change what the server is. */
  game?: string | null;
  gameConfig?: unknown;
  serverType: string;
  mcVersion: string;
  modpackSlug: string | null;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  executionMode: string;
}

/** Same start-with-create-fallback path used by the "start" server action. */
export async function attemptAutoRestart(node: NodeRef, server: RestartableServer): Promise<void> {
  const daemonClient = new DaemonClient(node);
  const targetContainerId = server.containerId || server.id;

  const serverMeta = {
    serverId: server.id,
    // Without these an auto-restart would quietly convert a non-Minecraft server
    // into a Minecraft one via the create fallback below.
    game: server.game || undefined,
    gameConfig: server.gameConfig || undefined,
    serverType: server.serverType as ServerType,
    mcVersion: server.mcVersion,
    modpackSlug: server.modpackSlug || undefined,
    serverPort: server.serverPort,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    eulaAccepted: true,
    executionMode: server.executionMode,
  };

  try {
    await daemonClient.startServer(targetContainerId, serverMeta);
  } catch (e: any) {
    await daemonClient.createServer(serverMeta as any);
    await daemonClient.startServer(targetContainerId, serverMeta);
  }
}
