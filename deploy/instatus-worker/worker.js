/**
 * Offsite health check for CraftControl, reporting into an Instatus status page.
 *
 * Instatus is a status page, not a monitor — something has to decide what to publish. That
 * something must not live in the same house as the panel: a checker running on the Unraid
 * box goes down with it, and the status page then sits reading "all systems operational"
 * through the exact outage it exists for.
 *
 * A Cloudflare Worker on a cron trigger is the smallest thing that satisfies that. It runs
 * on Cloudflare's machines, costs nothing on the free plan, and needs no server to patch.
 *
 * The panel sits behind Cloudflare already, so this check also covers DNS and the tunnel:
 * if the origin is unreachable, Cloudflare answers 521/522 and that reads as down here —
 * which is exactly right, because that is what a player would get too.
 */

/** Instatus component states. Anything else is rejected by the API. */
const OPERATIONAL = 'OPERATIONAL';
const DEGRADED = 'DEGRADEDPERFORMANCE';
const PARTIAL = 'PARTIALOUTAGE';
const MAJOR = 'MAJOROUTAGE';

/** A panel that has not answered in this long is down as far as anyone using it is concerned. */
const CHECK_TIMEOUT_MS = 10_000;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  /**
   * Manual trigger, for confirming the wiring works without waiting for the cron.
   *
   * Guarded by the same API key the Worker already holds: the route is on a public URL, and
   * an open endpoint that writes to a status page is an open endpoint for lying about one.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('key') !== env.INSTATUS_API_KEY) {
      return new Response('Not found', { status: 404 });
    }
    const result = await run(env);
    return Response.json(result);
  },
};

async function run(env) {
  const health = await checkPanel(env.HEALTH_URL);

  /*
   * Two components, because the two failures need different answers from whoever reads the
   * page. The panel being down is "nothing works, wait for me"; a node being down is "your
   * server is off, mine are fine" — and a person whose server is on a different node should
   * not be told everything is broken.
   */
  const results = [];
  results.push(await publish(env, env.COMPONENT_PANEL, health.panel));
  if (env.COMPONENT_NODES) {
    results.push(await publish(env, env.COMPONENT_NODES, health.nodes));
  }

  console.log(`[instatus] panel=${health.panel} nodes=${health.nodes} (${health.reason})`);
  return { ...health, published: results };
}

/**
 * Asks the panel how it is, and turns the answer into two component states.
 *
 * The HTTP status and the body answer different questions on purpose. A 200 means the panel
 * is serving and its database answered; the body says whether the things behind it are
 * healthy. Collapsing the two would either hide a dead node or declare a total outage
 * because one machine in a bedroom is switched off.
 */
async function checkPanel(healthUrl) {
  let res;
  try {
    res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      // Cloudflare caches aggressively by default, and a cached 200 would keep reporting
      // healthy long after the origin stopped answering.
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { 'user-agent': 'craftcontrol-instatus-check' },
    });
  } catch (err) {
    // No answer at all: DNS, the tunnel, or the box itself. Indistinguishable from here,
    // and identical from a player's point of view.
    return { panel: MAJOR, nodes: MAJOR, reason: `unreachable: ${err.message}` };
  }

  if (!res.ok) {
    return { panel: MAJOR, nodes: MAJOR, reason: `http ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    /*
     * 200 with something that is not the health endpoint. Usually a Cloudflare challenge or
     * a captive portal, which is not the panel answering — treating it as healthy is how a
     * monitor stays green through an outage.
     */
    return { panel: PARTIAL, nodes: PARTIAL, reason: 'unexpected response body' };
  }

  if (body.status === 'error') {
    return { panel: MAJOR, nodes: MAJOR, reason: 'database unreachable' };
  }

  // The panel is serving pages either way from here on.
  if (body.monitorStale) {
    // The node flags are not being updated, so they cannot be reported as fact.
    return { panel: DEGRADED, nodes: DEGRADED, reason: 'monitor loop stale' };
  }

  const { total = 0, online = 0 } = body.nodes ?? {};
  if (total === 0 || online === total) {
    return { panel: OPERATIONAL, nodes: OPERATIONAL, reason: `${online}/${total} nodes` };
  }
  return {
    panel: OPERATIONAL,
    nodes: online === 0 ? MAJOR : PARTIAL,
    reason: `${online}/${total} nodes`,
  };
}

/**
 * Sets one component's state.
 *
 * Sent on every run rather than only on a change, which keeps the Worker stateless — no KV
 * namespace, nothing to configure, and no way for a missed write to leave the page stuck on
 * a stale state. Setting a component to the state it already has is a no-op on Instatus's
 * side, so this does not generate incident noise.
 */
async function publish(env, componentId, status) {
  if (!componentId) return { componentId, skipped: true };
  try {
    const res = await fetch(
      `https://api.instatus.com/v1/${env.INSTATUS_PAGE_ID}/components/${componentId}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${env.INSTATUS_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      // Logged rather than thrown: a failed publish must not stop the other component from
      // being updated, and the next run is only minutes away.
      console.error(`[instatus] component ${componentId} -> ${status} failed: HTTP ${res.status}`);
      return { componentId, status, ok: false, http: res.status };
    }
    return { componentId, status, ok: true };
  } catch (err) {
    console.error(`[instatus] component ${componentId} -> ${status} failed: ${err.message}`);
    return { componentId, status, ok: false, error: err.message };
  }
}
