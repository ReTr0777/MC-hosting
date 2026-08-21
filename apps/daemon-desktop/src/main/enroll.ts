import type { EnrollResult, EnrollSubmission } from '../shared-types';

/**
 * Joining a panel with a setup code.
 *
 * The other way round — the panel exports a file, somebody sends it over, the app imports
 * it — needs an administrator for every machine and puts a plaintext daemon key through a
 * chat window on the way. That is workable for a fleet one person owns and hopeless for a
 * customer who just wants their own PC to host their own world.
 *
 * Here the machine does the registering. The key it sends is the one it generated on first
 * run and has never shown anyone; the code proves who asked for the node, and is worth
 * nothing a quarter of an hour later.
 */

/** How long to wait on the panel. The request probes this machine, so it is not instant. */
const ENROLL_TIMEOUT_MS = 30_000;

/**
 * What the user typed, turned into an origin, or an explanation of why it cannot be one.
 *
 * People paste all of these: a bare hostname, a full dashboard URL with a path on the end,
 * something with a stray space. Each is unambiguous about which panel is meant, so each is
 * accepted rather than met with "invalid URL".
 */
export function normalisePanelUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const value = (raw ?? '').trim();
  if (!value) return { ok: false, error: 'Enter the address of the panel you want to join.' };

  // A bare host is the commonest thing to type and is not a URL until it has a scheme.
  // https, because a panel reached over the internet without one should not be typed into.
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `"${value}" is not an address this app can reach.` };
  }

  if (!parsed.hostname) {
    return { ok: false, error: `"${value}" has no host in it.` };
  }

  // Everything after the origin is the page they happened to be on, not the panel.
  return { ok: true, url: parsed.origin };
}

/**
 * Registers this machine with the panel.
 *
 * Every failure is turned into a sentence the person at the keyboard can act on. This runs
 * on a machine with no console attached, at the one moment where "fetch failed" would tell
 * them nothing about whether they mistyped the address, mistyped the code, or are looking
 * at a panel that is down.
 */
export async function enrollWithPanel(
  panelUrl: string,
  submission: EnrollSubmission
): Promise<EnrollResult> {
  const endpoint = `${panelUrl}/api/nodes/enroll`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'it did not answer in time' : err?.message || 'it could not be reached';
    throw new Error(`Could not reach ${panelUrl} — ${reason}. Check the address and that this machine is online.`);
  }

  const body: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    // The panel's own wording is the useful one: it knows whether the code expired, was
    // already used, or was never a code at all.
    throw new Error(body?.error || `The panel refused the request (HTTP ${res.status}).`);
  }

  if (!body?.node?.id) {
    throw new Error('The panel accepted the code but did not describe the node. Try again, or ask an administrator.');
  }

  return body as EnrollResult;
}
