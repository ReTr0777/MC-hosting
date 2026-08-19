# MC Hosting

A game-server hosting control panel. A Next.js web panel drives one or more node
daemons, which run each game server in its own Docker container and expose it to
players through an FRP tunnel and a Velocity proxy.

## Layout

```
apps/
  web/            Next.js 14 panel — dashboard UI + the whole REST API (App Router)
  daemon/         Node agent that runs on each host: owns Docker, files, backups
  daemon-desktop/ Electron wrapper that installs the daemon on Windows as an app
  discord-bot/    Slash-command bot (/status, /start, /stop, /restart)
  proxy/          Velocity proxy image (public 25565 + REST API)
  proxy-plugin/   Java plugin giving Velocity the REST API the panel calls
  nanolimbo/      Limbo server that holds players while a sleeping server wakes
packages/
  shared/         Types, DTOs and game capability tables shared by web + daemon
deploy/           Unraid container templates and the frps tunnel config
docs/             Design notes and planning documents
```

`server/` and `scratch/` are gitignored local working directories, not part of
the build.

### `apps/web/src`

```
app/            Routes. `api/` is the REST surface, the rest are pages.
components/
  ui/           Design system — every panel builds from these primitives
  common/       Shared across more than one page
  servers/      The server-detail page and its tabs (+ integrations/ panels)
  account/      Account and profile settings
  admin/        Node and instance administration
context/        React providers (auth, theme, toasts, confirm dialogs, prefs)
hooks/          Reusable client hooks
lib/
  api.ts        Fetch wrapper every panel uses
  prisma.ts     Prisma client singleton
  audit.ts      Audit-log writer
  format.ts     Byte/date formatting
  auth/         Sessions, API keys, TOTP, password policy, secret encryption
  servers/      Server lifecycle, suspension, quotas, capacity, schedules, sleep
  diagnostics/  Crash-log analysis and the optional AI analyzer
  services/     Outbound clients: daemon, Velocity, Modrinth, email, Cloudflare
  integrations/ Catalog of recognised mods/plugins and their config schemas
  theme/        Theme file parsing and the bundled themes
  utils/        Chunked upload, public URL resolution, YAML patching
```

The four modules at the root of `lib/` are the ones nearly every route touches;
everything else is grouped by subsystem.

### `apps/daemon/src`

```
routes/         HTTP surface the panel calls
middleware/     Bearer-token auth
games/          Per-game behaviour (Minecraft, Terraria) behind one interface
services/
  runtime/      Docker, process supervision, PTY, lifecycle, console streaming
  content/      Modpacks and mods: Modrinth, CurseForge, mrpack, provisioning
  backup/       Local archives and S3 offload
  presence/     Player presence, server pings, sleep-on-empty
  network/      FRP tunnel client and BlueMap hosting
  scheduler.ts  Cron-style task runner
  system.ts     Host metrics
  file-history.ts  Config file revision history
utils/          Standalone helpers
```

## Development

```bash
npm install
npm run prisma:generate

npm run dev:web         # panel on :3000
npm run dev:daemon      # node agent on :3500
docker compose -f docker-compose.dev.yml up -d   # just Postgres
```

## Checks

```bash
npm test            # shared + daemon + web unit tests
npm run typecheck   # tsc --noEmit for web and daemon
npm run build       # shared -> daemon -> web
```

Tests live next to the code they cover, as `*.test.ts`, and run on the Node test
runner via `tsx`.

## Setting up a new node

A node is any Windows machine that will actually run game servers. The panel talks
to it over HTTP, so the two need to agree on an address and a shared key. Exporting
the config from the panel is the quickest way to make them agree — it carries the
key across so nobody retypes it.

**Before you start, on the node machine:**

- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and let
  it finish starting. Every game server is a container; the node cannot host
  anything without it.
- Find the machine's LAN address (`ipconfig` → IPv4 Address, e.g. `192.168.1.50`).
- Make sure the panel can reach port `3500` on it. On the same LAN this usually
  just works; across networks you will need a port forward or the FRP tunnel.

### 1. Create the node in the panel

Dashboard → **Nodes** → **Add Node**, as a global admin:

| Field | What to put |
| --- | --- |
| Name | Anything recognisable, e.g. `Spare PC` |
| Host | The node machine's LAN address |
| Port | `3500` unless it is already taken on that machine |
| API key | Invent a long random string — the node adopts it in step 3 |

It will save as **offline**. That is expected: nothing is running there yet.

### 2. Export its config

On the new node's card, click the **download icon** (⤓). This saves
`<node-name>-node-config.json`.

> This file contains the daemon key in plaintext. Send it privately — anyone holding
> it can control that node's servers. The export is admin-only and recorded in the
> audit log.

### 3. Install the app on the node machine

Download the latest **MC Hosting Node Setup** from
[Releases](https://github.com/ReTr0777/MC-hosting/releases) and run it. Windows
SmartScreen will warn because the build is unsigned — *More info* → *Run anyway*.

The app starts the node immediately, so it may report a port clash or a missing
Docker on first launch. Both are shown on the Overview tab.

### 4. Import the config

In the app: **Connection** → **Import config from panel…** → pick the file you
exported.

The app writes the key, port and enabled games, then restarts the agent. Within a
few seconds the node should show **Running**, and the panel's node card should flip
to online on its next refresh.

### 5. Check it over

- **Overview** — Docker should read *Running*, node state *Running*.
- Tick **start automatically when I sign in** so the node survives a reboot.
- Closing the window leaves the node online in the tray; only **Quit** from the tray
  menu takes it offline.

### If it does not come online

| Symptom | Cause |
| --- | --- |
| App says *Port 3500 is already in use* | Something else holds the port — often a daemon already running in Docker. Change it on the Connection tab, and change it on the node in the panel to match. |
| App is *Running*, panel says offline | The panel cannot reach the machine. Check the Host value in the panel and the Windows firewall on port 3500. |
| Panel says unauthorised | Key mismatch. Re-export from the panel and import again. |
| Docker reads *Not installed* / *Not running* | Install or start Docker Desktop, then **Check again**. |

The log behind **Logs → Open log file** (`%APPDATA%\MC Hosting Node\logs\node.log`)
records startup, the daemon's own output, and update checks.

Doing it the other way round also works: install the app first, then copy the
address and key off the **Connection** tab into the panel's Add Node form by hand.

## Windows node installer

`apps/daemon-desktop` packages the daemon as a Windows application, so a machine can
join as a node by running an installer instead of writing a compose file.

```bash
npm run dist:desktop     # -> apps/daemon-desktop/release/MC Hosting Node Setup <version>.exe
```

The installed app starts the daemon as a child process, keeps it in the system tray
(closing the window leaves the node online), and offers a window with node status,
the address and API key to paste into the panel, tunnel settings, and a live log.
It can start itself at sign-in.

**Docker Desktop is still required** — game servers are containers either way. The
app detects it and links to the download if it is missing.

Two things worth knowing about the build:

- The daemon is staged into `build/daemon` with its own `node_modules` by
  `scripts/stage-daemon.mjs`. That install deliberately runs in a temp directory
  outside the repo: npm resolves any install under `apps/` against the workspace
  root, and `--omit=dev` there would prune the root's devDependencies.
- Builds are unsigned, so Windows SmartScreen warns on first run. To sign, set
  `CSC_LINK` and `CSC_KEY_PASSWORD`, set `signAndEditExecutable: true` in
  `electron-builder.yml`, and build with Developer Mode on or from an elevated
  prompt — the signing toolchain contains symlinks Windows will not otherwise
  unpack.

Prisma is excluded from the packaged daemon. It is only used when `DATABASE_URL` is
set, both call sites load it lazily, and its native engines would add over 100 MB.

## Portable node (Linux, Raspberry Pi, Android)

Neither the Docker image nor the Windows installer suits a machine that cannot run
Docker at all. Android is the clearest case — no root, and a kernel built without
the cgroup and overlayfs support containers need — but the same applies to any host
where installing Docker is more trouble than the node is worth.

```bash
npm run dist:portable                  # -> apps/daemon/release/mc-hosting-node-<version>-linux-arm64.tar.gz
npm run dist:portable -- --arch=amd64  # for an x86 Linux box
```

Unpack it on the target and run `sh start.sh`. There is nothing to install and no
build step — it carries the same esbuild bundle the Windows installer ships, the
vendored `node-unrar-js`, the setup page, and an `frpc` for the right architecture.
Node.js and a JDK come from the target's package manager; the bundled `README.md`
covers Termux specifically.

**Servers run as processes, not containers.** `ExecutionMode.PROCESS` is already the
panel's default when creating a server, so this needs no configuration, but Docker
Container mode will not work on such a node. The node reports `dockerAvailable:
false` and a status of `degraded`, which `isHealthOnline` treats as online — Docker
is a capability, not liveness. Panel builds before that fix recorded such a node as
offline on every poll while storing the specs from the same reply, so the symptom
was an OFFLINE card showing real hardware.

Set `JAVA_BIN` if the JDK is not the one first on `PATH`. The version-based selection
in `resolveJavaCmd` looks under `/opt/java`, which only the Docker image has.

### Shipping an update

Installed nodes check GitHub Releases on launch and every six hours, download in the
background, and install on their own — a node picked up by someone else stays current
without being chased. Installing restarts the agent, so the node blinks offline in
the panel for a few seconds; the game servers are containers and keep running.

To cut a release:

```bash
# 1. Bump the version — updates trigger on this number alone.
#    apps/daemon-desktop/package.json  ->  "version": "1.0.1"

# 2. Build and upload the installer plus its latest.yml manifest.
export GH_TOKEN=<a token with repo scope>
npm --prefix apps/daemon-desktop run release
```

`npm run dist:desktop` still builds locally without publishing anything.

Two constraints worth remembering:

- **The releases must be readable without credentials.** An installed node has no
  GitHub token, so a private repo would mean shipping one to every machine.
- **The version must increase.** electron-updater compares versions and nothing
  else; re-publishing the same number is a no-op for every installed node.

`electron-updater` is inlined into `dist/` by `scripts/bundle-main.mjs` rather than
listed as a runtime dependency, because npm hoists it to the repo root where
electron-builder would not find it to package.

## Deployment

`docker-compose.yml` builds and runs the full stack (Postgres, panel, daemon,
frps, Velocity, limbo, Discord bot). Images publish to
`ghcr.io/retr0777/mc-hosting`. Unraid users can instead add the container
templates in `deploy/`.

`Jenkinsfile` builds, tests and publishes all five images, then deploys them to Unraid
over SSH using `deploy/docker-compose.prod.yml`. That compose file pulls rather than
builds and runs no database of its own — it expects the existing Postgres, reached
through the settings in a `.env` on the Unraid box (`deploy/env.prod.example`). The
pipeline never writes that file; the only secret it supplies is the database password,
passed in at deploy time.
