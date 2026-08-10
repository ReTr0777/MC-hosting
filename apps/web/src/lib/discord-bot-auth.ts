import { NextRequest } from 'next/server';

/**
 * Shared secret between the web panel and the standalone Discord bot service.
 * The bot is a trusted service, not a per-user session — it authenticates with this
 * secret, then the actual authorization is resolved per-command from the caller's
 * linked `discordUserId` and their ServerPermission rows.
 */
export function verifyBotSecret(req: NextRequest): boolean {
  const secret = process.env.DISCORD_BOT_SECRET;
  if (!secret) return false; // Bot integration is disabled unless explicitly configured
  return req.headers.get('x-bot-secret') === secret;
}
