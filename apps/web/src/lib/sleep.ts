import { DaemonClient } from '@/lib/daemon-client';

/**
 * Panel-side helpers for sleep-on-empty / wake-on-join.
 *
 * The daemon owns the mechanism (it holds the port and restarts the server); the panel
 * owns the policy (how long "empty" has to last before it counts).
 */

export interface SleepStatus {
  sleeping: boolean;
  state: 'sleeping' | 'waking' | null;
  port: number | null;
  sleptAt?: string | null;
  wakeStartedAt?: string | null;
  lastWakeError?: string | null;
}

export interface NodeRef {
  host: string;
  port: number;
  apiKey: string;
}

function clientFor(node: NodeRef): DaemonClient {
  return new DaemonClient(node);
}

export function targetFor(server: { id: string; containerId: string | null }): string {
  return server.containerId || `process-${server.id}`;
}

export async function getSleepStatus(node: NodeRef, serverId: string): Promise<SleepStatus> {
  return clientFor(node).request<SleepStatus>(`/servers/${serverId}/sleep`);
}

export async function requestSleep(
  node: NodeRef,
  server: { id: string; name: string; containerId: string | null; serverPort: number }
): Promise<void> {
  await clientFor(node).request(`/servers/${targetFor(server)}/sleep`, {
    method: 'POST',
    body: JSON.stringify({ serverName: server.name, port: server.serverPort }),
  });
}

export async function requestWake(
  node: NodeRef,
  server: { id: string; containerId: string | null }
): Promise<void> {
  await clientFor(node).request(`/servers/${targetFor(server)}/wake`, { method: 'POST' });
}

export async function cancelSleep(node: NodeRef, serverId: string): Promise<void> {
  await clientFor(node).request(`/servers/${serverId}/sleep`, { method: 'DELETE' });
}

/**
 * Decides what the monitor should do with one running server this tick.
 *
 * A null player count means the status ping failed — the server may be mid-start, lagging,
 * or firewalled. That is explicitly *not* treated as empty: sleeping a server that might
 * be full would be far worse than leaving a quiet one running.
 */
export function evaluateSleep(input: {
  sleepEnabled: boolean;
  sleepAfterMinutes: number;
  sleepEmptySince: Date | null;
  players: number | null;
  now?: Date;
}): { action: 'sleep' | 'mark-empty' | 'clear-empty' | 'none'; emptyForMs: number } {
  const now = input.now || new Date();

  if (!input.sleepEnabled) {
    return { action: input.sleepEmptySince ? 'clear-empty' : 'none', emptyForMs: 0 };
  }

  if (input.players === null) return { action: 'none', emptyForMs: 0 };

  if (input.players > 0) {
    return { action: input.sleepEmptySince ? 'clear-empty' : 'none', emptyForMs: 0 };
  }

  if (!input.sleepEmptySince) return { action: 'mark-empty', emptyForMs: 0 };

  const emptyForMs = now.getTime() - new Date(input.sleepEmptySince).getTime();
  const thresholdMs = Math.max(1, input.sleepAfterMinutes) * 60_000;

  return { action: emptyForMs >= thresholdMs ? 'sleep' : 'none', emptyForMs };
}
