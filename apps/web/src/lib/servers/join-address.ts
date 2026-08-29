import { proxyHostnames } from './proxy-sync';

/**
 * The address a player types into Minecraft to reach this server.
 *
 * Not the same thing as where the server is running, which is what the console header used
 * to show: `node.host:serverPort` is the daemon's own address, and on a node at home that is
 * a LAN address like 192.168.50.6:24007 — correct for the machine, useless to anybody who is
 * not standing in the same house.
 *
 * When a subdomain is set, the proxy is the front door. It binds :25565, the port a client
 * assumes, and routes on the hostname the player typed — so the address is the hostname
 * alone, with no port to explain. Falling back to host and port for a server with no
 * subdomain is right: there is genuinely no name pointing at it yet, and the direct address
 * is the only way in.
 */
export function joinAddress(
  server: {
    subdomain?: string | null;
    domain?: string | null;
    serverPort: number;
    node: { host: string };
  },
  defaultDomain: string
): string {
  // Built on the proxy's own idea of which hostnames reach a server, so the address shown to
  // a player and the address the proxy answers to cannot drift apart.
  const [hostname] = proxyHostnames(server, defaultDomain);
  return hostname || `${server.node.host}:${server.serverPort}`;
}
