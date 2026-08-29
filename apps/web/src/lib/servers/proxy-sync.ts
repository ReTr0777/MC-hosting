import { prisma } from '@/lib/prisma';
import { VelocityClient } from '@/lib/services/velocity-client';

/**
 * Keeping the Velocity proxy's idea of the world in step with the panel's.
 *
 * The proxy routes on the hostname a player typed, and it learns hostnames from here —
 * it has no database and no memory across restarts. Two rules fall out of that:
 *
 *   - **Every server stays registered, running or not.** Registration used to be tied to
 *     start and stop, which meant a stopped server did not exist as far as the proxy was
 *     concerned. That is exactly the server somebody is trying to reach when they want it
 *     woken up, so unregistering it removes the only path that could wake it.
 *   - **Registration is repeated, not remembered.** The proxy is registered with from
 *     scratch on every monitor tick, so a proxy that restarted, or that came up before the
 *     panel did, repairs itself within one tick instead of staying empty until someone
 *     restarts every server by hand.
 *
 * Only deletion unregisters.
 */

const DEFAULT_DOMAIN_FALLBACK = 'retr0net.nl';

function client(): VelocityClient {
  const velocity = new VelocityClient({ host: 'proxy', port: 3001 });
  velocity.setBaseUrl(process.env.VELOCITY_URL || 'http://proxy:3001/api/v1');
  return velocity;
}

/**
 * The addresses a player could type to reach this server through the proxy.
 *
 * Empty for a server with no subdomain: there is no name pointing at it, so the proxy has
 * nothing to match and such a player is only ever reaching it directly on its own port.
 */
export function proxyHostnames(
  server: { subdomain?: string | null; domain?: string | null },
  defaultDomain: string
): string[] {
  const subdomain = (server.subdomain || '').trim().toLowerCase();
  if (!subdomain) return [];

  const domain = (server.domain || defaultDomain || DEFAULT_DOMAIN_FALLBACK).trim().toLowerCase();
  if (!domain) return [];

  return [`${subdomain}.${domain}`];
}

/** The domain a server falls back to when it has not been given one of its own. */
export async function defaultDomain(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'DEFAULT_DOMAIN' } }).catch(() => null);
  return setting?.value || DEFAULT_DOMAIN_FALLBACK;
}

/**
 * Registers one server with the proxy.
 *
 * Failures are logged and swallowed. The proxy is an optional front door — a panel that
 * cannot reach it must still be able to start servers people connect to directly, and the
 * next tick will register this one anyway.
 */
export async function registerServerWithProxy(serverId: string): Promise<void> {
  try {
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      include: { node: true },
    });
    if (!server) return;

    await client().registerServer(
      server.id,
      server.node.host,
      server.serverPort,
      proxyHostnames(server, await defaultDomain())
    );
  } catch (err: any) {
    console.warn(`[proxy-sync] Failed to register server ${serverId} with the proxy: ${err.message}`);
  }
}

export async function unregisterServerFromProxy(serverId: string): Promise<void> {
  try {
    await client().unregisterServer(serverId);
  } catch (err: any) {
    console.warn(`[proxy-sync] Failed to unregister server ${serverId} from the proxy: ${err.message}`);
  }
}

/**
 * Registers every server. Called once per monitor tick.
 *
 * @returns how many were accepted, for the tick summary. A zero here with servers in the
 *   database means the proxy is unreachable, which is worth being able to see.
 */
export async function syncProxyServers(): Promise<number> {
  let registered = 0;

  try {
    const servers = await prisma.server.findMany({ include: { node: true } });
    if (servers.length === 0) return 0;

    const domain = await defaultDomain();
    const velocity = client();

    for (const server of servers) {
      try {
        await velocity.registerServer(
          server.id,
          server.node.host,
          server.serverPort,
          proxyHostnames(server, domain)
        );
        registered++;
      } catch {
        // Reported once below rather than once per server: an unreachable proxy fails for
        // all of them, and that is one fact, not fifty.
      }
    }

    if (registered < servers.length) {
      console.warn(`[proxy-sync] Registered ${registered}/${servers.length} servers with the proxy`);
    }
  } catch (err: any) {
    console.warn(`[proxy-sync] Proxy sync failed: ${err.message}`);
  }

  return registered;
}
