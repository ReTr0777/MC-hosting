# Multi-Game Support — Implementation Plan

Adding Terraria alongside Minecraft in one web panel, run as a **child process**
rather than a container, plus per-node game selection so an operator only hosts
what they opted into.

Status: **Phases 0–3 done.** Terraria runs end to end through the daemon API.
What remains is Phase 4 (§9): the web panel.

---

## 1. Goals

1. A single panel that hosts both Minecraft and Terraria servers, with the game
   chosen at creation time and visible on every server card.
2. **Nothing about Minecraft breaks.** This is the hard constraint the design is
   built around — see §2, which is the most important section here.
3. Terraria runs as a spawned child process, not a Docker container.
4. Node operators pick which games their node offers.

### Non-goals for this round

- Satisfactory or any third game. The seam should make it possible; see §10.
- Terraria in CONTAINER mode. PROCESS only for v1. This is what lets the whole
  feature avoid `docker.ts` entirely.
- tModLoader / Terraria mods.
- Generalising Modrinth, CurseForge, mrpack, ServerPackCreator, BlueMap,
  Velocity routing, or sleep/wake. These stay Minecraft-only and are gated off.
- Renaming CraftControl.

---

## 2. The isolation contract

The requirement is "separate enough that nothing Minecraft breaks", not
"completely separate". Those pull in opposite directions, so this section states
exactly where the line sits and how it is enforced.

### The rule

> **No existing Minecraft code path is edited. Terraria is reached by an early
> dispatch that Minecraft never enters, and reuses only helpers that are already
> game-neutral and stay byte-for-byte unchanged.**

Not "refactored carefully". Not touched. A `git diff` of a completed Terraria
feature should show essentially no changes inside the Minecraft launch path.

### Why this rules out the obvious approach

The tempting move is to extract every Minecraft specific into a
`games/minecraft.ts` and have both games call a common abstraction. That is
cleaner on paper and it is what a from-scratch design would do — but it means
rewriting `ensureServerJar`, the Java argument construction, `run.sh` handling,
jar caching and boot detection, all of which are load-bearing, heavily
special-cased, and have clearly absorbed a lot of hard-won bug fixes.

Rewriting them to add a second game puts every one of those fixes at risk for no
Minecraft-side benefit. **Additive dispatch is the correct trade here** even
though it duplicates a little.

### The touch points

**Written as two; shipped as three.** Phase 3 found a third that the original
analysis missed — the create route also provisions, and a Terraria server that
went through it unguarded would download a Minecraft jar into its own directory.
It is recorded here rather than quietly absorbed, because the count is the whole
point of this section.

All three are the same shape: an additive early return that Minecraft never
enters, with a Minecraft-preserving fallback.

**1. `ProcessManager.startProcess` — one guard at the top** (`apps/daemon/src/services/process.ts:232`):

```ts
public async startProcess(dto: CreateServerContainerDto): Promise<void> {
  if (dto.game && dto.game !== 'MINECRAFT') {
    return this.startGameProcess(dto);   // new method, separate file-level logic
  }
  // ...existing Minecraft body, entirely unchanged...
}
```

**2. `ProcessManager.stopProcess` — parameterise the stop command** (`:511`):

```ts
this.writeStdin(serverId, mp.stopCommand ?? 'stop');
```

The `?? 'stop'` default means an existing Minecraft process behaves identically
even if `stopCommand` is never populated.

**3. `POST /servers/create` — skip Minecraft provisioning** (`apps/daemon/src/routes/servers.ts`):

```ts
if (isOtherGame) {
  await definition.ensureBinary(serverDir, spec);
  return;
}
// ...existing Modrinth + ensureServerJar body, unchanged...
```

Two smaller changes come with it, both no-ops for Minecraft: `serverType` is
only *required* when the game is Minecraft (it is a Minecraft loader and means
nothing otherwise), and `eula.txt` is only written for Minecraft.

That is the whole footprint. Everything else Terraria needs already exists and
is already game-neutral.

Two more places turned out to be game-specific but were already parameterisable
rather than needing a guard — both take their value from the game module and
fall back to the Minecraft literal:

| Place | Was | Now |
|---|---|---|
| Pre-backup flush (`routes/servers.ts`) | `save-all` | `definition?.saveCommand ?? 'save-all'` |
| Pre-restore wipe (`services/backup.ts`) | `['world', 'world_nether', …]` | `getGame(...)?.restoreClearDirs ?? [same list]` |

### Shared without modification

These are reused as-is, no edits, no wrapping:

| Component | Location | Why it's safe |
|---|---|---|
| `writeStdin` | `process.ts:491` | Writes a line to stdin. No game knowledge. |
| `getProcessStats` | `process.ts:557` | `ps -o %cpu,rss` against a pid. |
| `killProcess` | `process.ts` | SIGKILL. |
| The `processes` map, `logBuffer`, `log` events | `process.ts:45+` | Plain bookkeeping. |
| Console WebSocket | `services/console.ts` | Log stream + stdin. Needs **zero** changes. |
| Files, backups, schedules, stats, icon, export/import | `routes/servers.ts` | ~35 of ~60 routes are already game-agnostic. |
| Port allocator | `api/servers/route.ts:275` | Allocates from a pool at 24000; never assumed 25565. |

### What Terraria adds, all of it new

- `apps/daemon/src/games/` — new directory, nothing else imports out of it into
  Minecraft paths.
- `ProcessManager.startGameProcess` — new method alongside the existing one.
- A binary installer (§6), the analogue of `ensureServerJar` but never called by
  Minecraft.

### Accepted duplication

`startGameProcess` will re-implement roughly 40 lines that `startProcess` also
does: the starting lock, the port clear, the spawn, the stdout/stderr wiring.
**This is deliberate.** Deduplicating it means editing the Minecraft path, which
the contract forbids. Revisit only once a third game makes the duplication
genuinely expensive — by then the Terraria path will have proven itself and the
shared shape will be obvious rather than guessed.

---

## 3. Why PROCESS mode is the right call

Preferring child processes turns out to be the *easier* path, not a constraint
to work around:

- **`ExecutionMode.PROCESS` already exists and is already the default** — the
  schema defaults to it (`schema.prisma:193`), the create wizard defaults to it
  (`dashboard/page.tsx:257`), and the API defaults to it
  (`api/servers/route.ts:123`). Terraria is not introducing a new execution
  model; it is using the one already in production.
- **`docker.ts` is never touched.** No image resolution, no `TYPE=`/`VERSION=`
  env contract, no `25565/tcp` port binding, no `ensureDockerImage`. That file
  is the single riskiest thing in the daemon for Minecraft regressions, and this
  plan does not open it. Compared with a container-based Terraria, this removes
  the four hardcoded port sites, the EULA guard, and `watchContainerStartup`
  from scope entirely.
- **The daemon runner image is `node:20-slim`** (Debian, glibc — see
  `apps/daemon/Dockerfile`), with `curl`, `unzip` and `p7zip-full` already
  installed. Terraria's Linux dedicated-server build is self-contained, so it
  should run there with no added runtime. **Verify this early** — see §9.
- **Terraria reads commands on stdin**, exactly as `writeStdin` provides.
- **The download is ~50 MB**, not a multi-GB Docker image.

### The one real cost

PROCESS-mode servers have **no memory or CPU cap** — Docker's `Memory` and
`NanoCpus` limits simply don't apply to a spawned child. This is already true
for Minecraft and is documented in `lib/node-capacity.ts:19-24`. Terraria's
footprint is small enough (~1 GB) that this is acceptable, but the capacity
model keeps counting *allocated* rather than *enforced* RAM, and that should be
a conscious acceptance rather than a surprise.

---

## 4. The game module

New directory, entirely additive:

```
apps/daemon/src/games/
  index.ts        // registry: getGame(id)
  types.ts        // GameDefinition interface
  terraria.ts     // the only implementation for now
```

Note there is deliberately **no `minecraft.ts`**. Minecraft keeps its existing
code path untouched; the registry only answers for games that opt in. Adding a
Minecraft module later is possible but is explicitly not part of this work.

```ts
export interface GameDefinition {
  id: 'TERRARIA';
  label: string;

  /** Ensures the server binary exists on disk; returns the executable path. */
  ensureBinary(serverDir: string, spec: GameServerSpec): Promise<string>;

  /** Writes config files needed before first boot. Critical — see §6. */
  prepareServerDir(serverDir: string, spec: GameServerSpec): Promise<void>;

  /** How to spawn it. */
  buildLaunch(serverDir: string, spec: GameServerSpec): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  /** Console command for a graceful shutdown. Terraria: "exit". */
  stopCommand: string;

  /** True when this log line means "booted and accepting connections". */
  isReadyLine(line: string): boolean;

  /** Join/leave/none from a log line. */
  parsePresenceLine(line: string): PresenceEvent | null;

  capabilities: GameCapabilities;
  defaults: { memoryMb: number; cpuLimit: number };
}
```

`GameCapabilities` lives in `packages/shared` so the web panel gates tabs off the
same flags the daemon uses:

```ts
interface GameCapabilities {
  consoleInput: boolean;
  players: boolean;
  whitelist: boolean;
  bans: boolean;
  mods: boolean;
  configFile: string | null;   // e.g. "serverconfig.txt"
  worldMap: boolean;
  sleepWake: boolean;
  subdomain: boolean;
  updateEngine: boolean;
  packHealth: boolean;
}
```

---

## 5. Data model

### `Server` (`apps/web/prisma/schema.prisma:185`)

```prisma
game        Game    @default(MINECRAFT)
gameConfig  Json?
```

`mcVersion` and `serverType` stay exactly as they are, documented as
Minecraft-only and ignored when `game != MINECRAFT`. Renaming them to
`gameVersion`/`variant` would touch 276 call sites across web, daemon and shared
for no functional gain — and every one of those sites is a chance to break
Minecraft. Explicitly out of scope.

Terraria's variant, world name, difficulty, max players and autocreate size all
live in `gameConfig`, typed in `packages/shared` and validated on write:

```ts
interface TerrariaConfig {
  variant: 'VANILLA' | 'TSHOCK';   // decided: gameConfig, not the ServerType enum
  worldName: string;
  autocreate: 1 | 2 | 3;           // small / medium / large
  difficulty: 0 | 1 | 2 | 3;
  maxPlayers: number;
  password?: string;
}
```

**Decision (Q1):** the variant lives here rather than extending the `ServerType`
Prisma enum. `ServerType` is read by Minecraft code paths, and extending it
would violate the isolation contract in §2 for no benefit. v1 ships `VANILLA`
only; `TSHOCK` is reserved in the type so adding it later is not a migration.

### `Node` (`schema.prisma:146`)

```prisma
enabledGames String[] @default(["MINECRAFT"])
```

Postgres, so a native array.

### New enum

```prisma
enum Game { MINECRAFT  TERRARIA }
```

Mirrored in `packages/shared/src/enums.ts`.

### `CreateServerContainerDto` (`packages/shared/src/dto.ts`)

Add `game?: Game`. Optional, so every existing caller — including the Discord
bot path in `lib/server-actions.ts` — keeps compiling and keeps meaning
Minecraft.

### Migration safety

The defaults make this a no-op: existing servers become `MINECRAFT`, existing
nodes advertise `["MINECRAFT"]`. No backfill, no operator action.

---

## 6. Terraria specifics

Vanilla dedicated server first; TShock is a `gameConfig` variant later.

### Binary installation

The analogue of `ensureServerJar`, but a separate function that Minecraft never
calls. Mirrors the existing jar-cache pattern (`process.ts:149` uses
`config.dataDir/cache/jars`) with `cache/terraria/<version>/`:

1. Download the official dedicated-server zip from terraria.org. The version is
   an **argument**, defaulted from the `TERRARIA_VERSION` pin (§11a) — never
   read from the constant inside the installer, so a version picker later needs
   no installer change.
2. Unzip, take `<v>/Linux/`, `chmod +x` both `TerrariaServer` and
   `TerrariaServer.bin.x86_64`.
3. Cache under `cache/terraria/<version>/` so a second Terraria server on the
   node is instant, and so two pinned versions can coexist.

### The first-boot trap

Started bare, a Terraria server sits at an **interactive world-configuration
prompt forever** — it will look like a hang, not a failure. `prepareServerDir`
must write a complete `serverconfig.txt` (world path, autocreate, difficulty,
maxplayers, port, password) *before* first launch so it boots unattended. This
is the single most likely thing to go wrong; the readiness probe needs a hard
timeout that fails loudly rather than waiting forever.

### Config file

`serverconfig.txt` is the same `key=value` with `#` comments shape as
`server.properties`. The existing comment-preserving parser and writer
(`routes/servers.ts:1851` and `applyServerProperties` at `:1878`) can be
**copied and parameterised on filename** — copied rather than refactored in
place, per §2.

### Verified by spike (2026-08-14, v1.4.4.9 — re-run 2026-08-14 against **v1.4.5.6**)

Everything below was measured against a real server booted inside the actual
daemon image (`ghcr.io/retr0777/mc-hosting:daemon`, `node:20-slim` base),
spawned exactly the way `process.ts` spawns Minecraft (`stdio:
['pipe','pipe','pipe']`, line-buffered capture). **No assumption in this section
is inferred.**

The second run re-verified every row against 1.4.5.6, the version §11a pins.
Everything held; two findings needed sharpening (marked below).

| Question | Answer |
|---|---|
| Runs on the daemon image? | **Yes, unmodified.** `ldd` reports **zero** unresolved libraries — it needs only libc/libm/librt/libdl/libpthread/libgcc_s/ld-linux. The build is MonoKickstart: it ships its own Mono and BCL. **The Dockerfile needs no change.** |
| Zip layout | Unchanged between 1.4.4.9 and 1.4.5.6: the archive unpacks to `<v>/{Linux,Mac,Windows}/`, and `Linux/` holds the `TerrariaServer` shell wrapper plus `TerrariaServer.bin.x86_64`. Both need `chmod +x`. |
| Unattended boot from a hand-written `serverconfig.txt`? | **Yes.** No prompt appears when the config is complete. |
| Time to ready | **~14.2 s** first boot (small-world generation), **~2.3 s** afterwards. |
| Ready line | `Server started` |
| Stop command | `exit` → `Saving before exit...` → clean **exit code 0**, in ~2.5 s. |
| Where world files land | Entirely under `worldpath` (`.wld` + `.wld.bak`). The unpacked server directory gained **exactly one** new file across a full boot — `serverconfig.txt`, which we wrote ourselves. The binary cache stays clean and a backup of the data dir is complete. |

#### Finding 1 — the console prompt contaminates lines *unpredictably* (sharpened at 1.4.5.6)

Terraria prints a `": "` prompt **with no trailing newline** after each command
completes. Whether it glues itself to the next line therefore depends on where
the stdout chunk boundary happens to fall:

- At 1.4.4.9 the ready line arrived as `": Server started"`.
- At 1.4.5.6 it arrived as plain `"Server started"`, with `": "` showing up
  later as **its own line**, after the `playing` response.

So the prefix is *sometimes* present. Neither `line === 'Server started'` nor
"always strip two characters" is safe.

`isReadyLine` and `parsePresenceLine` must strip an **optional** leading
`/^:\s*/` before matching, and a line that is nothing but the bare prompt must
be treated as noise rather than forwarded to the console buffer.

#### Finding 2 — presence strings are localized

Pulled from the binary's own localization table, not from a wiki:

```
LegacyMultiplayer.19 = "{0} has joined."
LegacyMultiplayer.20 = "{0} has left."
ClientWasBooted      = "{0} was booted: {1}"
ServerStarted        = "Server started"
```

These are translated per language. **`language=en/US` must therefore be pinned
by `prepareServerDir` and must not be a user-editable field**, or presence
parsing silently breaks for anyone who changes it. Note also there is no UUID
analogue — Terraria identifies players by name only, so the `players`
capability carries a name and nothing more.

#### Finding 3 — the first-boot trap is real, and worse than described

Launched without a config, the server prints a world-selection menu and sits at
`Choose World: ` **forever — even with stdin closed**. It does not error, does
not exit, and emits no trailing newline, so a line-based readiness probe sees
nothing whatsoever.

This confirms the hard-timeout requirement: the probe must fail loudly on a
timer, because there is no output to detect this state from.

#### Finding 4 — world generation floods the log, measured (sharpened at 1.4.5.6)

Counted exactly, on a **small** world — the cheapest size we offer:

> **30,675 progress lines in ~14 seconds, against 110 lines worth keeping.**

That is a 279:1 flood. `logBuffer` holds 300 lines (`process.ts:411`), so
forwarding these verbatim would evict every genuine startup line roughly a
hundred times over before the server even finished booting — and would do the
same to the websocket stream. Large worlds will be worse.

`startGameProcess` must drop these rather than forward them. The shape is tight
and stable across both versions:

```
/^\d+(\.\d+)?% - .+ - \d+(\.\d+)?%$/     e.g. "60.3% - Smoothing the world - 0.0%"
```

Two caveats found at 1.4.5.6 that the 1.4.4.9 regex missed:

- Not all progress lines carry the ` - ` infix. `"Resetting game objects 96%"`
  and `"Validating world save: 24%"` are the same kind of noise in a different
  shape, and survive the regex above.
- The bare `": "` prompt line (Finding 1) is also noise.

`isNoiseLine` on `GameDefinition` exists for exactly this, and should cover all
three shapes rather than only the first.

#### Bonus — `playing` gives presence without log parsing

Confirmed again at 1.4.5.6: `playing` returns the connected list on its own
clean line — literally `No players connected.` when empty, followed by the `": "`
prompt.

A poll is a sturdier basis for the `players` capability than log tailing, since
it resynchronises after a missed line. Log parsing stays useful for live
join/leave events.

### Capabilities

```
consoleInput: true    players: true      configFile: "serverconfig.txt"
whitelist: false      bans: false        mods: false
worldMap: false       sleepWake: false   subdomain: false
updateEngine: false   packHealth: false
defaults: { memoryMb: 1024, cpuLimit: 1.0 }
```

### Cross-game backup guard

**Decision (Q3):** restoring a backup taken from one game onto a server of
another game is **hard-blocked**, not merely warned about. Nothing checks this
today, and the failure mode is bad — a Minecraft world tarball unpacked over a
Terraria server dir produces a server that will not boot and whose original
files are gone.

Implementation:

1. Record the game in the backup metadata at creation time
   (`routes/servers.ts:2047`, the backup POST).
2. On restore (`:2083`), reject with a clear error when the backup's game does
   not match the target server's.
3. **Backups created before this change have no game field.** Treat a missing
   value as `MINECRAFT` rather than as "unknown, refuse" — otherwise every
   existing backup becomes unrestorable, which would be a Minecraft regression
   and a §2 violation.

The guard belongs in the daemon, not just the panel, so the Discord bot and any
direct API caller are covered too.

---

## 7. Node game selection

**Correction to the original premise:** nothing is pre-downloaded today.
`ensureDockerImage` (`docker.ts:55`) pulls lazily on first create, so a
Minecraft-only node has never fetched anything else. And since Terraria is
PROCESS mode, there is no image at all — just a ~50 MB binary.

So the value is not saved bandwidth. It is:

1. The node picker only offers nodes that can run the chosen game, instead of
   failing deep inside provisioning.
2. Pre-fetching the binary on enable, so the first create isn't a wait.
3. Explicit operator control over what runs on their machine.

### Flow

The transport already exists: `api/nodes/[id]/ping/route.ts:31` copies
daemon-reported health into the `Node` row every 5 seconds.

1. `config.ts` — `enabledGames: string[]` on `DaemonConfig`, default
   `['MINECRAFT']`.
2. `routes/setup.ts:74,89` — expose and accept it on the existing `GET`/`POST
   /config` pair (already behind `requireSetupPassword`).
3. `src/public/index.html` — checkbox group. On save, **background**-fetch the
   binary for newly enabled games; never block the save on a download.
4. `services/system.ts` — include it in `getSystemHealth()`; add to
   `DaemonHealthDto`.
5. `api/nodes/[id]/ping/route.ts` — one more field in the existing update.
   Treat `undefined` as "leave unchanged" so an older daemon never clobbers it
   to empty.
6. Create wizard (`dashboard/page.tsx`, node select at `:1422`) — filter on
   `enabledGames`. Explanatory empty state when no node supports the game.
7. `api/servers/route.ts` — reject a node/game mismatch server-side. The
   dropdown is not a security boundary.
8. AUTO node selection must filter by capability before ranking by capacity.

### Guard rail

Disabling a game on a node that still runs servers of that game must not break
them. Warn in the setup GUI, leave running servers alone, block only *new*
creations.

---

## 8. Web panel

### Tab gating

`TABS` (`dashboard/servers/[id]/page.tsx:74`) gains `requires?: keyof
GameCapabilities` per entry and filters on the server's capabilities.

Terraria hides: Mods, Integrations, World Map, Pack Health, Update Centre,
Domain, Sleep & Wake, Whitelist, Bans.
Terraria keeps: Console, Players, Backups, Settings, Resources, Schedules,
Files.

Handle a deep link to a hidden tab (`?tab=mods`) by falling back to Console.

### Per-game tab naming

**Decision (Q4):** the product keeps the CraftControl name, but Terraria's tabs
get their own labels — recognisably the same tab, worded for the game. That
means `TABS` entries carry per-game overrides rather than a single fixed string:

```ts
{
  key: 'properties',
  label: 'Settings',
  labelByGame: { TERRARIA: 'World Settings' },
  hint: 'Game rules from server.properties — difficulty, MOTD, view distance and more.',
  hintByGame: {
    TERRARIA: 'Game rules from serverconfig.txt — difficulty, max players, password and more.',
  },
  requires: 'configFile',
}
```

Falling back to `label`/`hint` when no override exists means **every existing
Minecraft entry is unchanged** — the override map is purely additive.

Proposed Terraria labels (adjust freely, these are a starting point):

| Tab key | Minecraft | Terraria |
|---|---|---|
| `console` | Console | Console |
| `players` | Players | Players |
| `properties` | Settings | **World Settings** |
| `backups` | Backups | **World Backups** |
| `resources` | Resources | Resources |
| `schedules` | Schedules | Schedules |
| `files` | Files | Files |

The bigger win is the **hints**, which is where the Minecraft-specific wording
actually lives — every retained tab's hint mentions Minecraft concepts and needs
a Terraria rewrite. Same for empty states and the Players tab's op/kick copy.

### Theming constraint — must not break custom themes

**This is a hard constraint, and it is easy to violate by accident.**

`THEME_TOKENS` (`lib/theme-tokens.ts:48`) is a **closed allowlist** of 17 colour
tokens plus 4 decoration tokens, and `parseThemeFile` silently ignores anything
outside it. So:

- **Terraria UI must not introduce any new CSS custom property.** A
  `--terraria-accent` would be unsettable by a user's theme file, ignored by the
  parser, and would render identically under every theme — exactly the breakage
  to avoid.
- **All structure must use the existing `cc-*` classes** (`cc-tab`, `cc-card`,
  `cc-btn-*`, `cc-section-title`, `cc-badge-*`) and the existing tokens. Terraria
  tabs are the same design system, not a parallel one.
- **Game/engine badge colours may use a hardcoded hex**, following the existing
  `serverTypeMeta` precedent (`dashboard/page.tsx:692`, e.g. `FABRIC: '#a78bfa'`).
  Those are deliberately theme-independent identity colours. A Terraria badge
  fits that pattern — but it must be legible against `--bg` and `--surface` in
  both light and dark palettes (`BASE_PALETTES`, `theme-tokens.ts:314`).
- **Decoration tokens must still work.** `--bg-image`, `--bg-scene` and
  `--bg-animation` render behind the whole panel; any new Terraria surface needs
  the same background treatment as existing tabs or it will punch a hole in a
  decorated theme.

Phase 4 is not done until the Terraria tabs have been eyeballed under at least
one built-in theme, one light palette, and one custom theme that sets the
decoration tokens.

### Creation wizard

Game becomes **step 0**. Choosing Terraria skips the engine, MC-version and
modpack steps entirely rather than showing them disabled.

### Elsewhere

- Game badge on server cards (`dashboard/page.tsx:1012`), per the colour rule
  above.
- `ServerCardIcon` (`:188`) needs a Terraria fallback icon.
- Global search and audit-log copy carry Minecraft-only wording; make
  game-neutral where the string is shared between games. **Not** a rebrand —
  the CraftControl name and logo stay exactly as they are.

---

## 9. Phases

Each is independently shippable and leaves `main` working.

### Phase 0 — Feasibility spike ✅ **DONE**

Ran 2026-08-14 against v1.4.4.9 in a stock `node:20-slim` container, and
**re-run the same day against v1.4.5.6** — the version §11a pins — inside the
real daemon image. Results are recorded as the verification table and four
findings in §6.

**Verdict: green.** The binary runs on the daemon image unmodified, so neither
feared outcome materialised — no Dockerfile runtime additions, and no fallback
to CONTAINER mode for Terraria. The plan stands as written.

Three findings change implementation details rather than the design: the `": "`
prompt prefix (§6 Finding 1), the pinned `language=en/US` (Finding 2), and
worldgen log throttling (Finding 4).

### Phase 1 — Node game capability ✅ **DONE**

All of §7. With only `MINECRAFT` in the enum this is a deliberate user-visible
no-op: every node defaults to Minecraft-only, so nothing changes for anyone.

**Shipped:**

| Where | Change |
|---|---|
| `packages/shared/src/enums.ts` | `Game` enum, `GAME_LABELS`, `ALL_GAMES`, `DEFAULT_ENABLED_GAMES`, `isGame`, `parseGameList`. |
| `packages/shared/src/dto.ts` | `enabledGames?: Game[]` on `DaemonHealthDto` — optional, so an older daemon simply omits it. |
| `daemon/src/config.ts` | `enabledGames` on `DaemonConfig`, normalised on both load and save. |
| `daemon/src/routes/setup.ts` | Returned by `GET /config` (with `availableGames` for rendering); validated on `POST`, **400 on an empty list** rather than a silent fallback. |
| `daemon/src/services/system.ts` | Reported in `getSystemHealth()`. |
| `daemon/src/public/index.html` | "Games Hosted On This Node" checkbox group, rendered from what the daemon reports. Warns before submit, not only after. |
| `web/prisma/schema.prisma` | `Node.enabledGames String[] @default(["MINECRAFT"])`. |
| `web/api/nodes/[id]/ping` | Synced on the existing 5s ping; `undefined` leaves the stored value alone. |
| `web/api/nodes` | `enabledGames` added to the select so the picker can filter on it. |
| `web/api/servers` | Capability filter runs **before** capacity ranking in the AUTO scheduler; explicit-node choices rejected with 400. |
| `web/dashboard/page.tsx` | `gameCapableNodes` filters the picker; a node that loses the capability mid-wizard resets to Auto. |
| `web/src/lib/game-capability.test.ts` | 8 tests, all on the back-compat rule. |

**Deviation from the plan as written:** `Node.enabledGames` was listed under
Phase 2, but Phase 1 step 5 syncs into it, so the column had to land here. The
`Game` enum came with it for the same reason. Phase 2 therefore only adds
`Server.game` and `gameConfig`.

**No migration file needed** — deployment runs `prisma db push` on container
start (`apps/web/Dockerfile:59`), and the column has a default.

**Verified:** daemon + web typecheck clean, both build clean, 94/94 tests pass.

### Phase 2 — Schema + dispatch ✅ **DONE**

`Server.game`, `gameConfig`, the `game` field on the DTO, the `games/` registry,
and the two touch points from §2. (`Game` and `Node.enabledGames` landed in
Phase 1.)

**Shipped:**

| Where | Change |
|---|---|
| `packages/shared/src/enums.ts` | `TERRARIA` added to `Game` and `GAME_LABELS`. `DEFAULT_ENABLED_GAMES` stays Minecraft-only, so no node gains a game by being upgraded. |
| `packages/shared/src/games.ts` | New. `GameCapabilities` + `GAME_CAPABILITIES` for both games, `TerrariaConfig`, `parseTerrariaConfig`. |
| `packages/shared/src/dto.ts` | `game?: Game` and `gameConfig?: TerrariaConfig` on `CreateServerContainerDto`; `serverType`/`mcVersion` documented as Minecraft-only. |
| `web/prisma/schema.prisma` | `enum Game`, `Server.game @default(MINECRAFT)`, `Server.gameConfig Json?`. |
| `daemon/src/games/` | New. `types.ts` (`GameDefinition`), `index.ts` (`getGame`, `registerGame`, `isNonMinecraftGame`). Empty registry until Phase 3. |
| `daemon/src/services/process.ts` | The two touch points, plus `startGameProcess` and an optional `stopCommand` on `ManagedProcess`. |
| `web/api/servers` | Reads `game` off the request, persists it, forwards it to the daemon. |
| `web/api/servers/[id]/migrate` | Carries `game`/`gameConfig` to the destination node. |
| `daemon/src/games/registry.test.ts` | 6 tests on the dispatch rule. |
| `web/src/lib/terraria-config.test.ts` | 9 tests on config coercion and capability coverage. |

**Deviation:** creating a non-Minecraft server is refused with a 400 by
`api/servers`. The seam exists and dispatches, but nothing can launch Terraria
until Phase 3 registers the module — a row plus a failure deep in provisioning
is worse than a clear refusal.

> **Still in place after Phase 3, deliberately.** The daemon can now run
> Terraria, but the panel has no game step and no `gameConfig` editor, so
> lifting the guard would let the API accept something the UI cannot produce or
> display. **Removing it is the first task of Phase 4**, alongside the wizard
> step that makes it meaningful.

**`startGameProcess` is dispatch-only in this phase.** It resolves the registry
and fails loudly; Phase 3 fills in ensureBinary → prepareServerDir →
buildLaunch → spawn.

**Verified.** `git diff` of the Minecraft path is 54 insertions and **one**
deleted line — `this.writeStdin(serverId, 'stop')`, replaced by the
`?? 'stop'` form. `docker.ts`, `routes/servers.ts` and `lifecycle.ts` are
untouched.

Full manual cycle on a real Minecraft server (vanilla 1.21.4, PROCESS mode, live
daemon + panel + Postgres):

| Step | Result |
|---|---|
| Create via AUTO scheduler | ✅ row written with `game: MINECRAFT`, `gameConfig: null` |
| DTO reaches the daemon | ✅ `"game":"MINECRAFT"` in the create request and in `craftcontrol-meta.json` |
| Start | ✅ guard not entered, original Java spawn, `Done (2.820s)! For help, type "help"`, panel `RUNNING` |
| Console | ✅ `say` dispatched and echoed by the server |
| Stop | ✅ graceful, **exit code 0**, no force-kill — `?? 'stop'` behaves as the literal did |
| Backup | ✅ 136 MB snapshot |
| Restore | ✅ succeeded, and `game` survived the zip round-trip |
| Start after restore | ✅ `Done (0.766s)!` |
| `game: "TERRARIA"` on create | ✅ 400, no row |
| `game: "QUAKE"` on create | ✅ falls back to `MINECRAFT` rather than dispatching |
| Daemon start with `game: TERRARIA` in meta | ✅ dispatched, failed loudly, **no jar downloaded and no Java spawned** |

Typecheck clean on daemon and web; 48 daemon + 103 web tests pass.

### Phase 3 — Terraria daemon support ✅ **DONE**

`games/terraria.ts`, the binary installer, `startGameProcess`, the copied
config-file routes, and the cross-game backup guard (§6).

**Shipped:**

| Where | Change |
|---|---|
| `daemon/src/games/terraria.ts` | New. `TERRARIA_VERSION` pin, version-parameterised installer, `prepareServerDir`, launch spec, and the four line matchers. |
| `daemon/src/games/index.ts` | Registers Terraria. |
| `daemon/src/games/types.ts` | `saveCommand` and `restoreClearDirs` added to `GameDefinition`. |
| `daemon/src/services/process.ts` | `startGameProcess` filled in: lock, install, prepare, port clear, spawn, noise-filtered log wiring, ready detection with a hard timeout, presence, `stopCommand`. |
| `daemon/src/routes/servers.ts` | Touch point 3; `GET`/`POST /:serverId/gameconfig`; game-aware pre-backup flush. |
| `daemon/src/services/backup.ts` | Cross-game restore guard, game-aware pre-restore wipe. |
| tests | `terraria.test.ts` (13), `backup.test.ts` (5), `registry.test.ts` updated. |

#### Binary layout — settled by experiment

The build is executed **in place from a shared per-version cache**
(`cache/terraria/<version>/`), never copied into the server directory. Verified:
two servers running concurrently from one cache booted on their own ports with
separate worlds, and the cache directory gained **no files at all**. Keeping the
binary out of the server directory is also what makes a Terraria backup 1.1 MB
instead of 46 MB.

This is not optional, it is forced: **MonoKickstart `cd`s to its own directory
during startup**, so the process's working directory is always the binary cache
no matter what `cwd` is passed. Every path in `serverconfig.txt` is therefore
absolute — a relative one would resolve into the shared cache.

#### Two bugs the live run caught that unit tests could not

1. **Stats measured the wrong process.** Spawning the `TerrariaServer` shell
   wrapper meant `ProcessManager` held the pid of a 3 MB bash process while the
   real server ran as its child — `getProcessStats` reported **3 MB for a server
   using 601 MB**. Fixed by spawning `TerrariaServer.bin.x86_64` directly and
   setting `MONO_IOMAP=all` ourselves, which is the only thing the wrapper
   contributed. Now reports 601 MB / 25% CPU.
2. **`": : "` reached the console.** When two commands complete inside one
   stdout chunk the prompts concatenate, and the noise matcher only stripped
   one. Fixed by stripping a *repeated* prefix — which also hardens
   `isReadyLine` and `parsePresenceLine`, since a doubled prompt would have
   hidden a real line behind it.

**Verified** against the real daemon image, driven entirely through the daemon
HTTP API:

| Step | Result |
|---|---|
| Create with no `serverType` | ✅ 202 — a Terraria create is not asked for a Minecraft loader |
| Binary install | ✅ 45 MB fetched once, unpacked to `cache/terraria/1.4.5.6` |
| `serverconfig.txt` written before first boot | ✅ complete, absolute paths, `language=en/US` pinned |
| Start | ✅ world generated, `Server started`, tracked pid is the game itself |
| Console log buffer | ✅ **7 clean lines** — worldgen flood fully filtered |
| Console input | ✅ `playing` → `No players connected.`; `password` → `No password set.` |
| Stats | ✅ 601 MB / 25.2% CPU |
| `GET`/`POST /gameconfig` | ✅ resolves `serverconfig.txt` from the game; edits merge, comments preserved |
| Restart after edit | ✅ user's `maxplayers`/`motd` kept, panel-owned keys re-asserted |
| Backup (live) | ✅ `save` accepted (`Backing up world file`), 1.1 MB |
| Restore (same game) | ✅ succeeded and restarted |
| **Minecraft backup → Terraria server** | ✅ **refused**, world left intact |
| **Terraria backup → Minecraft server** | ✅ **refused** |
| **Legacy backup (no `game` field) → Minecraft** | ✅ **restored**, back-compat holds |
| Stop | ✅ `exit` sent, **exit code 0**, no force-kill |
| Delete with `deleteData` | ✅ server directory gone, shared cache retained |
| Minecraft in the same daemon | ✅ boots (`Done (3.215s)!`), console works, stats 1359 MB, stops with code 0 |

65 daemon + 103 web tests pass; both apps typecheck clean.

### Phase 4 — Web panel (~2 days)

Capability-gated tabs, per-game labels and hints, game step in the wizard,
badges, icons, defaults.

**Done when:**

- the full lifecycle works through the UI;
- an existing Minecraft server looks and behaves exactly as before, with every
  tab label and hint unchanged;
- Terraria tabs have been checked under a built-in dark theme, a light palette,
  and a custom theme that sets the decoration tokens (§8);
- no new CSS custom property has been introduced — verifiable by diffing against
  `THEME_TOKENS`.

**Total: ~1 week.**

---

## 10. Notes toward a third game

- **Helps:** files, backups, schedules, resources, crash restart, stat history
  and node capability all come free. `GameCapabilities` already carries
  `consoleInput` separately from console presence, so a game with no stdin
  interface is expressible.
- **Satisfactory specifically:** no stdin console at all, so anything
  interactive needs a client for its HTTPS Server Manager API. Multiple ports
  including **UDP**, which neither the allocator nor the process path models. An
  ~8–12 GB RAM baseline that shifts quota assumptions — and with no cgroup cap
  in PROCESS mode, that is a real operational risk. Honest estimate: 1–2 weeks
  on top of this, and it may genuinely want CONTAINER mode.

---

## 11. Decisions

Settled, with the section that implements each:

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Terraria variant modelling | `gameConfig` JSON field, **not** the `ServerType` enum. v1 ships vanilla; `TSHOCK` reserved in the type. | §5 |
| 2 | Discord bot game awareness | **Minecraft-only for v1.** `runServerAction` is not touched. | below |
| 3 | Cross-game backup restore | **Hard block**, with pre-existing backups treated as Minecraft. | §6 |
| 4 | Naming and tab copy | Keep the CraftControl name and logo. Terraria gets its own tab labels and hints via additive per-game overrides, built strictly on the existing design tokens. | §8 |

### Q2 in detail — the Discord bot stays Minecraft-only

`runServerAction` (`apps/web/src/lib/server-actions.ts:49`) duplicates the
panel's action path and is **not modified**. Two consequences to be deliberate
about:

- A Terraria server will not appear in, or respond to, bot commands. That is
  accepted for v1.
- The bot's start path hardcodes `status: 'RUNNING'` on success (`:78`) and
  builds a Minecraft `serverMeta`. Since it never receives a `game` field, it
  keeps behaving exactly as it does now — the DTO's `game` is optional
  specifically so this file compiles untouched.

If the bot later needs Terraria, that is the moment to consider unifying it with
`/api/servers/[id]/action` rather than adding a second duplicate.

---

## 11a. Still open

1. **Crash auto-restart tuning** — the existing 30-minute crash window and
   exponential backoff (`Server.crashCount` / `crashWindowStartedAt`) were tuned
   for Minecraft. Phase 0 saw a clean `exit 0` on the normal stop path and no
   crash behaviour suggesting otherwise, so this stays **as-is**. Closed unless
   Phase 3 turns something up.
2. ~~**Terraria version pinning**~~ — **Decided 2026-08-14: ship the latest
   version, pinned as a constant, with the seam for a picker left in place.**

   The download URL is
   `https://terraria.org/api/download/pc-dedicated-server/terraria-server-<v>.zip`
   where `<v>` is the version with dots stripped (`1.4.4.9` → `1449`), and the
   zip unpacks to a `<v>/Linux/` directory.

   **There is no "latest" endpoint.** Probing the download API directly
   (2026-08-14) found the ceiling at **1.4.5.6** — `1457` and up return 404,
   `1456` returns a 45.6 MB zip. So "latest" cannot be resolved at runtime; it
   has to be a version we chose, tested, and wrote down.

   Therefore:

   - `TERRARIA_VERSION = '1.4.5.6'` is a single exported constant, verified by
     the spike re-run recorded in §6.
   - `ensureBinary` takes the version as a **parameter**, never reads the
     constant itself, and caches under `cache/terraria/<version>/`. Adding a
     picker later is then a `gameConfig` field and a dropdown — no installer
     change, and two versions can coexist on one node.
   - Bumping the pin is a one-line change plus a re-run of the §6 spike. Do not
     bump it without re-running the spike: 1.4.5.6 already shifted two of the
     four Phase 0 findings.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| ~~Terraria binary won't run on `node:20-slim`~~ | **Retired.** Phase 0 proved it runs unmodified (§6). |
| Terraria first-boot prompt hangs the process | **Confirmed real** in Phase 0 — it hangs at `Choose World: ` indefinitely even with stdin closed, emitting no newline. `prepareServerDir` writes a full config before launch; the readiness probe's hard timeout is the only possible detector. |
| Presence parsing breaks when the language changes | `language=en/US` is pinned by `prepareServerDir` and not user-editable (§6 Finding 2). |
| Worldgen log flood evicts real lines from the console buffer | Drop or coalesce lines matching `/^\d+\.\d+% - /` in `startGameProcess` (§6 Finding 4). |
| Touching `process.ts` breaks Minecraft | Isolation contract (§2): exactly two touch points, both with Minecraft-preserving defaults. Manual full-lifecycle test before merge. |
| Duplicated spawn logic drifts between the two paths | Accepted for v1 and recorded here. Revisit at game three, not before. |
| No RAM cap in PROCESS mode | Already true for Minecraft; Terraria's footprint is ~1 GB. Consciously accepted. |
| Operator disables a game that has live servers | Warn, don't enforce retroactively; block only new creations. |
| Old daemon + new panel | Missing `enabledGames` means "leave unchanged", never clobber to empty. |
| Terraria UI introduces a token custom themes can't set | `THEME_TOKENS` is a closed allowlist (`theme-tokens.ts:48`). Build only on existing `cc-*` classes and tokens; check against a decorated custom theme before Phase 4 closes. |
| Backup guard makes existing Minecraft backups unrestorable | Backups with no recorded game are treated as `MINECRAFT`, never as "unknown, refuse". |
| Per-game tab labels accidentally change Minecraft copy | `labelByGame`/`hintByGame` are additive overrides; Minecraft falls through to the existing `label`/`hint` strings untouched. |
