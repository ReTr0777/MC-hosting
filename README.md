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

## Bringing your own machine

A customer can turn their own PC into a node without an administrator touching anything.
The panel issues a short setup code; the node app redeems it and registers the machine
itself. Nobody types a bearer token, and the key never leaves the machine that generated
it except in the one request that registers it.

**On the panel:** the Nodes rail → **Connect a machine of your own**. Name it if you like,
and it hands you a code good for 15 minutes and one machine.

**On that machine:** install [MC Hosting Node](https://github.com/ReTr0777/MC-hosting/releases).
On a fresh install the app opens its own setup and asks for everything in order — Docker,
which games to host, how much of the machine to hand out, then the panel address and the
code. The dialog in the panel says so the moment the machine checks in. (An established
node never sees the wizard; **Connection → Connect to a panel** does the same job.)

The limits step is worth pausing on: it decides what the panel records as the node's
capacity, and it defaults to three quarters of the RAM and one core short of the total.
This is somebody's PC as well as a node — registering it at its full size is how a machine
ends up swapping with every server "fitting" perfectly. It is changed afterwards on the
node's page in the panel, which its owner can now reach.

### Setup does not finish until the panel can see the node

Registering an address is not the same as being reachable at it, and the gap between those
two swallowed every early failure: the node app said connected, the daemon was healthy, the
tunnel client reported success, and the panel — the only party that knew nothing answered
where it was looking — just showed the node offline.

So the node now asks. After applying its settings it polls `POST /api/nodes/enroll/verify`,
authenticated with its own daemon key, for up to two minutes: long enough for frpc to
register its proxy and the agent to finish restarting. The panel tries the tunnel address
first and the machine's own addresses after, registers the node at whichever answered, and
says which. The tunnel is preferred because it survives the node changing network or
lease; direct is the fallback that gets taken rather than merely offered.

When nothing answers, the app names every address it tried and what each failure means — a
refused direct address is a firewall, a refused tunnel address is a port the tunnel server
is not publishing. Those need different fixes, and nothing else in the system distinguishes
them.

### Nodes need nothing open on their own network

A node reaches the panel through the hosting tunnel, and a tunnel is dialled **outbound**:
frpc connects to frps on port 7000 and frps republishes the node's 3500 on a port of its
own. So a machine joining as a node needs no forwarded router port, no static address, and
no inbound firewall rule — which is the whole point, because the person plugging in their
laptop is not going to arrange any of those.

Only the panel's own network carries anything inbound, and how much depends on whether
the Velocity proxy is deployed. **7000** is forwarded either way, so nodes can dial in.

**With the proxy** (`apps/proxy` plus `apps/nanolimbo`): forward **25565** as well, and
that is the whole of it for a server with a subdomain. The proxy dials the backend at
`node.host:serverPort` from inside the network, so the game-server range never faces the
internet. Only a server with **no** subdomain needs its own port forwarded.

**Without the proxy** — it is optional, and an installation can run the panel, frps and
nodes without ever starting it — every server is reached by a direct connection to
`<public address>:<serverPort>`, so the **whole game-server range has to be forwarded**.
Subdomains do not route, and a player connecting to a machine that is powered off gets a
refused connection rather than the limbo screen, because the thing that would have held
them is the proxy. Sleep-on-empty still works: the daemon's own sleeper holds the port
(`apps/daemon/src/services/presence/sleeper.ts`) and owes nothing to Velocity.

The port frps republishes a node's API on is dialled by the panel from the same host, so it
stays inside the network and must never be forwarded.

Windows Firewall therefore only matters for an installation with **no** tunnel configured,
where the panel has to connect in directly. The node app still checks for its own rule and
offers to create one (Overview → *Reachable from the panel*, and step 2 of setup, which is
skippable), because a direct hop is one hop cheaper where it genuinely works.

If a node stops answering, **Find this node again** on its page re-probes it — the tunnel
first, then every address the machine reported when it joined, so a node that is reachable
both ways stays on the route that survives it moving. No new setup code needed.

### Keeping it up without anybody watching

Two switches, and a node that survives a reboot needs both:

- **Start this node when I sign in** (Overview tab) — the app's own login item. Note that
  Windows matches a login item on its arguments as well as its path: the app registers
  itself with `--hidden`, so anything reading the setting back has to say so too, or
  Windows reports it as off while it is on.
- **Start Docker Desktop when this app starts** (Overview tab, on by default) — the app
  launches Docker and waits for the engine, which takes minutes on a cold boot. There is
  also a button to set Docker's *own* start-at-sign-in, with its window suppressed; that
  one is written into Docker's settings file and is best set while Docker is stopped,
  since Docker rewrites that file when it exits.

Without them the machine comes back from a reboot with a node that is either not running
or running with no engine to put containers on — the servers stay down and the panel can
only say the node is offline.

What happens in between is the part worth knowing about:

- The node sends its own generated key, its port, its addresses and what the machine is
  (RAM, cores, games it hosts).
- If the installation has a tunnel, the panel allocates a port on frps and returns the
  tunnel settings. The node writes them, restarts, and is reachable at
  `frps:<allocated port>` — its own daemon still on 3500 behind it. This happens even for a
  machine on the panel's own LAN that a direct probe would have reached, because the
  alternative needs a port open on the node and is registered against an address that stops
  being true the moment the machine moves.
- Only an installation with **no** tunnel probes the machine's own addresses and registers
  it at whichever answers.

  **The tunnel server must publish that range.** frps accepts a proxy on any port it is
  asked for and listens for it inside its own container, so a port Docker was never told to
  publish is unreachable from where the panel dials it — and the node then sits offline
  with a tunnel that looks healthy from every angle except the one that matters. The range
  is `NODE_TUNNEL_PORT_RANGE` (default `25051-25100`, clear of the game servers' own
  tunnels, which are allocated from `24000` upward through `25000`), and the compose files
  publish it on frps to match. Widening one without the other is the failure this paragraph
  exists to prevent.

  On Unraid the frps container runs on **host networking** for exactly this reason. A
  template's port mappings are one port each, so a "range start" and a "range end" entry
  publish those two numbers and nothing between them — a whole range of nodes that enroll
  cleanly and never come online. Host networking has nothing to publish and nothing to keep
  in step. (`docker port` printing nothing for that container is what host mode looks like,
  not a container that forgot to publish.)

- **The panel needs its own address for frps**, which is rarely the one nodes use. Nodes
  dial the public address from Settings, from outside the network. The panel dials frps
  from inside it, where reaching that public address means asking the router to hairpin —
  and a router that will not simply drops the probe. `FRP_PANEL_HOST` is what the panel dials
  instead: the frps container's name where the two share a Docker network, and the host's
  LAN address where they do not, as on Unraid's default bridge. Unset, the panel uses the
  public address for both and every tunnelled node reads as offline.
- With neither route available the node is still registered, offline, at its best guess of
  an address — nothing is lost if the user forwards a port later.

### What an enrolled node is

A node enrolled this way has an **owner**, and that changes what it is:

| | Fleet node | Enrolled node |
| --- | --- | --- |
| Visible to | everyone | its owner and global admins |
| Servers placed by | anyone, and the scheduler | its owner only |
| Renamed, drained, deleted by | global admins | its owner, or a global admin |
| Overcommit and offload priority | global admins | global admins only |

Nodes that existed before this have no owner and keep behaving exactly as they did: shared,
visible, schedulable. Ownership is a single column, not a permission table — a machine has
one hoster, and lending someone's home PC to strangers is not a feature.

### Moving a world between machines

**Server page → advanced mode → Move to another node.** The destination list holds every
node the account may use: the shared fleet, and any machine the user has enrolled. So a
world moves onto their PC and back again by the same route, and cannot be pushed onto
anybody else's machine.

The migration itself is unchanged and careful about it: the server is stopped, the whole
directory is streamed across, file and byte counts are compared, the destination has to
finish provisioning, and only then is the source copy deleted. Anything short of all four
leaves the original where it is.

### Taking turns hosting

A group who play together can pass one world between their own PCs, which the rule above
otherwise forbids — and forbids for a good reason, since it is what stops a forty-gigabyte
modpack landing on somebody's SSD unasked.

The consent is moved rather than removed. **Server page → advanced → Machines that may host
this server**: the owner of a machine offers it, once, for that one server. After that any
of the server's owners or admins can move it between the offered machines without asking
again. Offering grants nothing else in either direction — the machine's owner gets no say
over the server, and the server's admins get no access to the machine.

Withdrawing an offer only removes the permission. A server running there is left alone,
because stopping somebody's game the moment its host changes their mind about *future*
handoffs is not what withdrawing consent should mean; moving it off is a handoff like any
other.

**The machine holding the world has to be online to give it up.** A migration reads the
files off that daemon, so a host who has gone away takes the server with them until they
come back. No backup is substituted: the copy on their disk is newer than any backup, and
silently swapping one for the other loses whatever was played in between.

## Setting up a new node

A node is any Windows machine that will actually run game servers. The panel talks
to it over HTTP, so the two need to agree on an address and a shared key. Exporting
the config from the panel is the quickest way to make them agree — it carries the
key across so nobody retypes it.

This is the administrator's route, and it produces a shared fleet node. For a machine
that belongs to one account, see [Bringing your own machine](#bringing-your-own-machine)
— that one needs no admin and no config file.

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
| Enrolled with a code, tunnel connected, panel still says offline | The panel is dialling a port frps does not publish, or dialling frps at an address it cannot reach from where it runs. Check `NODE_TUNNEL_PORT_RANGE` and `FRP_PANEL_HOST` on the panel container against what the frps container publishes (`docker port <frps container>`). |
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
