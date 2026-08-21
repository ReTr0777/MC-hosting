/** Thin client for the CraftControl web panel's bot-facing API. */
import type { ServerSummary } from './ui';

const WEB_API_URL = process.env.WEB_API_URL || 'http://localhost:3000';
const BOT_SECRET = process.env.DISCORD_BOT_SECRET || '';

/*
 * The panel can be slow to answer a start on a cold node, but an interaction Discord has
 * not heard back about within its own window is lost either way. Failing at 20s produces
 * a message saying so; hanging produces "the application did not respond", which reads as
 * the bot being broken.
 */
const REQUEST_TIMEOUT_MS = 20_000;

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${WEB_API_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': BOT_SECRET,
        ...options.headers,
      },
    });
  } catch (err: any) {
    // Naming the panel matters here: every one of these looks identical from Discord, and
    // the fix is on the box, not in the bot.
    if (err?.name === 'TimeoutError') {
      throw new Error(`The panel at ${WEB_API_URL} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not reach the panel at ${WEB_API_URL}. Check WEB_API_URL and that the panel is up.`);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data.error === 'Forbidden') {
      throw new Error(
        'The panel rejected this bot. DISCORD_BOT_SECRET must be set to the same value on both the bot and the panel.'
      );
    }
    const err: any = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data as T;
}

export type { ServerSummary };

export async function linkAccount(code: string, discordUserId: string): Promise<{ success: boolean; username: string }> {
  return call('/api/discord/link', { method: 'POST', body: JSON.stringify({ code, discordUserId }) });
}

export async function listServers(discordUserId: string): Promise<ServerSummary[]> {
  const { servers } = await call<{ servers: ServerSummary[] }>(
    `/api/discord/servers?discordUserId=${encodeURIComponent(discordUserId)}`
  );
  return servers;
}

export async function getServer(discordUserId: string, serverId: string): Promise<ServerSummary | null> {
  const servers = await listServers(discordUserId);
  return servers.find((s) => s.id === serverId) ?? null;
}

export async function runAction(
  discordUserId: string,
  target: { serverId?: string; serverName?: string },
  action: 'start' | 'stop' | 'restart'
): Promise<{ message: string; status: string; serverName: string }> {
  return call('/api/discord/action', {
    method: 'POST',
    body: JSON.stringify({ discordUserId, ...target, action }),
  });
}

export function isNotLinkedError(err: any): boolean {
  return err?.status === 404 && err?.message === 'NOT_LINKED';
}
