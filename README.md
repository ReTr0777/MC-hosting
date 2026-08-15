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

## Deployment

`docker-compose.yml` builds and runs the full stack (Postgres, panel, daemon,
frps, Velocity, limbo, Discord bot). Images publish to
`ghcr.io/retr0777/mc-hosting`. Unraid users can instead add the container
templates in `deploy/`.
