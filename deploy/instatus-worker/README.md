# Offsite status checks → Instatus

Instatus publishes a status page; it does not decide what to publish. This Worker does the
deciding, and it runs on Cloudflare rather than at home — which is the whole point. A checker
on the Unraid box goes down with the box, and the status page then reads "all systems
operational" straight through the outage it exists for.

Cost: nothing. Instatus's free plan covers the page, and Cloudflare's free plan covers a
Worker on a cron trigger with room to spare.

## 1. The status page

1. Sign up at [instatus.com](https://instatus.com) and create a page.
2. Add components. Two is enough to start:
   - **Web Panel** — the site itself.
   - **Game Nodes** — the machines that run servers.

   They are separate because the two outages need different answers. The panel being down is
   "nothing works"; a node being down is "your server is off, other people's are fine".
3. **Developers → API**: copy the API key, and note the page id from the dashboard URL.
4. Component ids: `curl -H "Authorization: Bearer <API_KEY>" https://api.instatus.com/v1/<PAGE_ID>/components`

Point a subdomain at the page if you like — but **not one that resolves through your own
tunnel**. A status page hosted behind the thing it reports on is a status page that goes down
exactly when it is needed.

## 2. Deploy the Worker

From this directory:

```bash
npx wrangler login
# Fill HEALTH_URL, INSTATUS_PAGE_ID and the component ids in wrangler.toml first.
npx wrangler secret put INSTATUS_API_KEY
npx wrangler deploy
```

Check it without waiting for the cron — the key is required because the URL is public and an
open endpoint that writes to a status page is an open endpoint for lying about one:

```bash
curl "https://craftcontrol-status.<your-subdomain>.workers.dev/?key=<API_KEY>"
npx wrangler tail          # watch the scheduled runs
```

## What it reports

The Worker reads `/api/health` on the panel, which answers two questions separately:

| `/api/health` says | Panel | Game Nodes |
|---|---|---|
| no response, or a 5xx | major outage | major outage |
| 200, `status: "error"` (database unreachable) | major outage | major outage |
| 200, `monitorStale: true` | degraded | degraded |
| 200, every node online | operational | operational |
| 200, some nodes online | operational | partial outage |
| 200, no node online | operational | major outage |

`monitorStale` is the one worth understanding. The panel's own node polling runs in-process
every 45s; if it dies, every node keeps reading as online forever. So the health endpoint
reports the age of the newest poll, and a stale one is published as degraded rather than as
the good news the stale flags would otherwise imply.

## Why `/api/health` and not `/`

Next.js serves the homepage perfectly happily with the database unreachable, so a monitor on
`/` stays green while the panel is completely unusable. `/api/health` touches the database and
returns 503 when it cannot — the check can actually fail.

It is unauthenticated by necessity and returns no node names, hostnames or versions. A health
check on a public URL is not a place to publish an inventory of the infrastructure.

## What this does not cover

An HTTP check cannot see a job that silently stops producing output — the nightly backup that
wrote a 0-byte archive would pass every check here. That needs the opposite shape: a
dead-man's switch such as [healthchecks.io](https://healthchecks.io), pinged on success, which
alerts on silence.
