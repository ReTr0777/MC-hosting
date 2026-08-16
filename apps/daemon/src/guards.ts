/*
 * Last line of defence for the node process.
 *
 * A node agent is unattended software on someone else's machine. Node's defaults are
 * the opposite of what that wants: an 'error' event with no listener throws, an
 * unawaited rejection exits, and either one takes down a node hosting live game
 * servers because some optional side errand failed. That is exactly how this daemon
 * died on a missing tunnel binary, and then again on a blocked one.
 *
 * So the rule here is: a failed operation fails, and the node keeps running. The
 * failure is logged loudly enough to diagnose, because the alternative — a silent
 * exit whose only trace is a stack trace in a log nobody was watching — is what makes
 * these problems take hours to find.
 *
 * Genuinely unrecoverable startup failures are handled at their source instead, where
 * there is enough context to say something useful (see the server 'error' handler in
 * index.ts, which exits on a port clash rather than pretending to be up).
 *
 * Imported first in index.ts, so these are registered before any other module's
 * top-level code gets the chance to fail.
 */

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  return String(value);
}

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    console.error(`[Daemon] Unhandled rejection: ${describe(reason)}`);
    console.error('[Daemon] That operation failed; the node is still running.');
  });

  process.on('uncaughtException', (err) => {
    console.error(`[Daemon] Uncaught exception: ${describe(err)}`);
    console.error('[Daemon] That operation failed; the node is still running.');
  });
}
