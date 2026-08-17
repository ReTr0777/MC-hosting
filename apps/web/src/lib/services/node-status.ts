import { DaemonHealthDto } from '@mc-manager/shared';

/**
 * Whether a health reply means the node is up.
 *
 * This used to read `health.status === 'ok' || health.dockerAvailable`, which made
 * Docker the definition of liveness. The daemon reports `status: 'degraded'` when it
 * cannot reach a Docker socket, so a node with no Docker at all answered every poll
 * correctly and was recorded as offline every time — the panel even stored the CPU
 * model and memory from the very reply it was rejecting, which is why such a node
 * showed real hardware specs on an OFFLINE card.
 *
 * That is wrong on its own terms, not just for Docker-free nodes. Servers can run in
 * ExecutionMode.PROCESS, which needs no Docker whatsoever and is the panel's default
 * when creating one. A node whose Docker Engine has died is still reachable, still
 * answering, and can still run and stop process-mode servers; calling it offline
 * hides working servers and fires a false NODE_OFFLINE notification.
 *
 * Liveness is therefore: the node answered, and what it said was a health report.
 * Whether Docker is present is a capability, carried separately in `dockerAvailable`
 * for the callers that actually need a container.
 *
 * The status check is not just a formality — `request()` resolves on any 2xx with a
 * JSON body, so a captive portal or a misrouted tunnel port can return 200 and
 * something that is not this daemon. Requiring a known status keeps that from
 * registering as a healthy node.
 */
export function isHealthOnline(health: DaemonHealthDto | null | undefined): boolean {
  return health?.status === 'ok' || health?.status === 'degraded';
}
