/**
 * The FRP tunnel preset.
 *
 * Every node in a deployment tunnels to the same FRP server with the same token, so
 * the details are a property of the installation rather than of any one node. Storing
 * them once in the panel lets a node's exported config carry them, instead of the
 * operator being told three more values to type into the desktop app by hand.
 *
 * The shaping below is pure so the settings form, the export route and the tests all
 * agree on what counts as "configured" — an address alone is the deciding field,
 * because a tunnel with no server to reach is not a tunnel.
 */

export const FRP_ADDR_KEY = 'FRP_SERVER_ADDR';
export const FRP_PORT_KEY = 'FRP_SERVER_PORT';
export const FRP_TOKEN_KEY = 'FRP_TOKEN';

/** frps listens here unless told otherwise; matches the daemon's own default. */
export const FRP_DEFAULT_PORT = 7000;

export interface FrpPreset {
  serverAddr: string;
  serverPort: number;
  token: string;
}

/**
 * Builds the preset a node config should carry, or null when no tunnel is set up.
 *
 * A blank or unusable port falls back to the default rather than failing: the port is
 * the least likely field to be deliberate, and refusing the whole preset over it would
 * strand the address and token that were entered on purpose.
 */
export function buildFrpPreset(
  addr: string | null | undefined,
  port: string | number | null | undefined,
  token: string | null | undefined
): FrpPreset | null {
  const serverAddr = (addr ?? '').trim();
  if (!serverAddr) return null;

  const parsed = typeof port === 'number' ? port : parseInt(String(port ?? ''), 10);
  const serverPort = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : FRP_DEFAULT_PORT;

  return { serverAddr, serverPort, token: (token ?? '').trim() };
}

/**
 * Checks an address before it is saved.
 *
 * frpc wants a bare host or IP — it builds its own connection from that plus the
 * port. Pasting a browser URL is the obvious mistake, and one that produces a tunnel
 * that silently never connects, so it is worth catching at the form.
 */
export function validateFrpAddr(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = (raw ?? '').trim();

  // Empty is legitimate: it means "this deployment has no tunnel".
  if (!value) return { ok: true, value: '' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { ok: false, error: 'Enter just the host, without http:// or https:// — for example panel.example.com' };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: 'The tunnel address cannot contain spaces.' };
  }
  if (value.includes('/')) {
    return { ok: false, error: 'Enter just the host, with no path — for example panel.example.com' };
  }
  if (value.includes(':')) {
    return { ok: false, error: 'Put the port in the port field rather than after a colon.' };
  }

  return { ok: true, value };
}
