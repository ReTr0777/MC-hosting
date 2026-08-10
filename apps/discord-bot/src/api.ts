/** Thin client for the CraftControl web panel's bot-facing API. */

const WEB_API_URL = process.env.WEB_API_URL || 'http://localhost:3000';
const BOT_SECRET = process.env.DISCORD_BOT_SECRET || '';

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${WEB_API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-bot-secret': BOT_SECRET,
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export interface ServerSummary {
  id: string;
  name: string;
  status: string;
  serverType: string;
  mcVersion: string;
}

export async function linkAccount(code: string, discordUserId: string): Promise<{ success: boolean; username: string }> {
  return call('/api/discord/link', { method: 'POST', body: JSON.stringify({ code, discordUserId }) });
}

export async function listServers(discordUserId: string): Promise<{ servers: ServerSummary[] }> {
  return call(`/api/discord/servers?discordUserId=${encodeURIComponent(discordUserId)}`);
}

export async function runAction(
  discordUserId: string,
  serverName: string,
  action: 'start' | 'stop' | 'restart'
): Promise<{ message: string; status: string }> {
  return call('/api/discord/action', {
    method: 'POST',
    body: JSON.stringify({ discordUserId, serverName, action }),
  });
}

export function isNotLinkedError(err: any): boolean {
  return err?.status === 404 && err?.message === 'NOT_LINKED';
}
