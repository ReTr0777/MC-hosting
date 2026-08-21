import { execFile } from 'child_process';

/**
 * The Windows Firewall rule that lets the panel reach this node.
 *
 * Windows blocks inbound connections to a listening port unless something has said
 * otherwise, and nothing had. The node came up, bound its port, reported itself healthy to
 * anyone asking locally — and was invisible from every other machine on the network,
 * including the panel probing it during enrollment. The failure looks nothing like a
 * firewall: the app says Running, the daemon logs are clean, and the panel simply calls
 * the node offline.
 *
 * A rule needs administrator rights, which a per-user install does not have, so opening
 * the port asks for them through UAC. Reading the rule back does not, which is what lets
 * the app show the true state without prompting anybody.
 */

const RULE_NAME = 'MC Hosting Node';
const PROBE_TIMEOUT_MS = 8000;

export type FirewallState = 'open' | 'missing' | 'unknown';

export interface FirewallStatus {
  state: FirewallState;
  detail: string;
}

function netsh(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('netsh', args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '') });
    });
  });
}

/**
 * Whether the rule exists and covers the port the node is actually listening on.
 *
 * The port matters as much as the rule: changing the daemon's port leaves the old rule in
 * place, allowing a port nothing listens on while the new one stays blocked. Reported as
 * "missing" rather than "open" so the app offers to fix it.
 */
export async function firewallStatus(port: number): Promise<FirewallStatus> {
  const { ok, stdout } = await netsh(['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`]);

  if (!ok || /No rules match/i.test(stdout)) {
    return {
      state: 'missing',
      detail: `Windows Firewall is blocking port ${port}. The panel cannot reach this node until it is allowed through.`,
    };
  }

  // netsh prints localised field names, so match the number rather than the label. A rule
  // for "Any" local port covers this one too — unusual, but it is not blocking anything.
  const covered = new RegExp(`(^|\\D)${port}(\\D|$)`, 'm').test(stdout) || /:\s*Any\s*$/m.test(stdout);
  if (covered) {
    return { state: 'open', detail: `Port ${port} is allowed through Windows Firewall.` };
  }

  return {
    state: 'missing',
    detail: `Windows Firewall has a rule for this app, but not for port ${port} — the node's port has changed since it was created.`,
  };
}

/**
 * Creates (or replaces) the rule, prompting for administrator rights.
 *
 * Deleting first makes this safe to run repeatedly and is what keeps the rule pointing at
 * the current port: netsh has no "replace", and adding a second rule with the same name
 * leaves the stale one allowing a port nobody uses.
 *
 * Waits for the elevated process so the caller can re-read the state and tell the user
 * what actually happened, rather than reporting success the instant UAC appears.
 */
export function openFirewall(port: number): Promise<{ ok: boolean; detail: string }> {
  const commands =
    `netsh advfirewall firewall delete rule name="${RULE_NAME}" >nul 2>&1 & ` +
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow ` +
    `protocol=TCP localport=${port} profile=private,domain`;

  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process cmd -ArgumentList '/c','${commands.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`,
      ],
      { timeout: 120_000, windowsHide: true },
      (err) => {
        if (!err) {
          resolve({ ok: true, detail: `Port ${port} is now allowed through Windows Firewall.` });
          return;
        }
        // The overwhelmingly common failure is the UAC prompt being declined, which is a
        // decision rather than a fault and should not read like a crash.
        resolve({
          ok: false,
          detail:
            'Windows did not grant permission to change the firewall. Without it the panel cannot reach ' +
            `this node — you can do it by hand from an administrator prompt:\n\n` +
            `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow protocol=TCP localport=${port}`,
        });
      }
    );
  });
}

/*
 * profile=private,domain and not public: a node is reached across a home or office
 * network, and opening a listening port on whatever coffee-shop Wi-Fi a laptop joins next
 * is not a trade this app should make on someone's behalf. A machine whose LAN is
 * classified Public in Windows will need that changed — which is the right thing to fix
 * anyway, since Windows treats it as a network of strangers.
 */
