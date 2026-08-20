# Wake-on-join without the rejoin — implementation plan

Today a player who joins a sleeping server is disconnected and told to come back
in thirty seconds. This replaces that with two mechanisms: holding the player's
connection open until the server is ready, and parking them in a limbo world when
the wait is too long to hold.

Status: **Phase 1 built** (`sleeper.ts`, with `sleeper.test.ts` covering it).
**Phase 2 built** — §4.1–4.3 done, §4.4 deliberately left alone. §5 and §8 record what
each implementation turned up.

---

## 1. What happens now

`apps/daemon/src/services/presence/sleeper.ts` holds the port of a stopped server
with a small TCP listener that speaks enough of the handshake to answer a status
ping and to notice a login attempt. On a login it does this
(`sleeper.ts:123`):

```ts
socket.write(loginDisconnect(entry.wakeMessage));  // "Reconnect in about 30 seconds"
socket.end();
void wake(entry.serverId)
```

The rejoin is the design rather than a defect — the listener has to release the
port before the real server can bind it, and there was nowhere to put the player
in the meantime. Both phases below are about finding somewhere to put them.

The repo already contains the parts for the second answer: Velocity
(`apps/proxy`), NanoLimbo (`apps/nanolimbo`) and a Velocity plugin
(`apps/proxy-plugin`), currently wired as a prototype. §4 covers what is wrong
with it.

---

## 2. Phase 1 and Phase 2 are both wanted

They are not alternatives. They serve **different entry paths**:

| Player connects to | Served by | Ceiling |
|---|---|---|
| `node-host:24001` directly | Phase 1 — hold and forward | Client login timeout |
| The proxy on `:25565` | Phase 2 — limbo and transfer | None |

Direct connection is the main path today: every server has its own port and the
sleeper binds it. Phase 2 does nothing for those players, because their packets
never reach the proxy.

The one case where Phase 1 becomes redundant is a deliberate decision to make the
proxy the only front door and firewall the backend ports — which is a decision
worth taking on its own merits (§4.4), not a side effect of this work.

**Build Phase 1 first.** It is self-contained, needs no proxy, works on every
client version, and covers vanilla and light-Fabric servers completely.

---

## 3. Phase 1 — hold the connection and forward it

Contained entirely within `sleeper.ts`. No proxy, no protocol implementation
beyond the handshake parsing already there.

### 3.1 The mechanism

`net.Server.close()` stops the listener *accepting* new connections but leaves
sockets it has already accepted alive. That is what makes this possible: the
sleeper can hand the port to the real server while still holding the player.

1. Client connects and sends handshake (next-state 2) plus login start. Buffer
   the bytes; send nothing back.
2. Close the listener. The port is now free to bind; the player is still
   connected.
3. Start the server. Poll `127.0.0.1:<port>` until it accepts a connection.
4. Dial the server, replay the buffered bytes, then pipe both directions.

The player waits at "Logging in…" and then joins. No disconnect, no rejoin.

Everything after step 4 is a byte pipe, so encryption and online-mode work
untouched — the backend runs its own login sequence with the client through us.

### 3.2 The client timeout, and how to survive it

Minecraft's connection handler drops after roughly **30 seconds** of silence.
Vanilla boots inside that. A modpack does not.

**Verify this number first.** Hold a real client at login and time the drop. The
shape of this phase depends on it, and it is one measurement.

The way past it is legal protocol. During login a server may send *Login Plugin
Request* packets, and the client answers them. One every ~10 seconds, on a
namespace the client will not recognise, feeds both sides' timeouts indefinitely:

- Our packet resets the client's read timeout.
- The client's reply resets ours.

The exchange is between the sleeper and the client only. The backend never sees
it — step 4 replays just the buffered handshake and login start — so the replay
stays clean. Login Plugin Request may be sent more than once, so this does not
violate the state machine.

`lazymc` uses this same hold-and-forward design, so it is proven outside this
codebase.

### 3.3 Cases that need handling

- **Several players during one wake.** More than one can connect before the
  server binds. Queue every held socket and pipe each as the backend accepts it,
  rather than serving the first and dropping the rest.
- **A server that fails to boot.** Disconnect with the real reason instead of the
  current message promising it will be up in thirty seconds. The daemon already
  knows why — see the Java preflight in `runtime/java-version.ts`.
- **A player who gives up mid-wake.** The socket closes; the wake must continue
  regardless, since the server was already told to start.
- **The listener closing while a status ping is in flight.** Status pings are
  short and stateless; simplest is to let them finish and only defer the close
  until the login path needs the port.

### 3.4 What this phase cannot do

The player watches a loading screen with no feedback. There is no chat, no title
and no boss bar during login state — nothing can be shown to them. That is
tolerable at twenty seconds and poor at three minutes, which is what Phase 2 is
for.

---

## 4. Phase 2 — limbo, for waits too long to hold

The player lands in NanoLimbo (a real world, with the boss bar and title already
configured in `apps/nanolimbo/settings.yml`) and is moved to the backend when it
is live. No time limit.

Three things must be fixed before this works at all.

### 4.1 The plugin sends players to the wrong server

`VelocityRestPlugin.java:58` loops every registered server and takes the first
one that is not the limbo:

```java
for (RegisteredServer targetServer : server.getAllServers()) {
    if (!"nanolimbo".equals(targetName)) {
        player.createConnectionRequest(targetServer).fireAndForget();
        break;
```

With a single backend this is invisible. With two, a player waiting for server A
is thrown at server B.

**Fix:** keep a per-player map of who is waiting for which backend, populated
from `player.getVirtualHost()` — the hostname the client actually typed —
in `PlayerChooseInitialServerEvent`.

### 4.2 It transfers blind

The same loop fires a connection request every three seconds whether or not the
backend is up.

**Fix:** `RegisteredServer.ping()` first and transfer only on a successful reply.
An open TCP port is not the same as ready to accept logins, and the gap between
them is exactly where a booting modpack sits.

### 4.3 Nothing maps a hostname to a server

`velocity-client.ts:18` registers backends under `server.id` — a UUID — and
nothing records which hostname should reach it. Meanwhile:

- `apps/proxy/velocity.toml` hardcodes `naggi = "192.168.50.129:25009"` and
  `try = ["naggi"]`. That second line is what disables the limbo path today.
- The daemon's `/servers/:id/subdomain` route
  (`apps/daemon/src/routes/servers.ts`) writes a subdomain into
  `craftcontrol-meta.json` and nothing ever reads it.

**Fix:** send the hostname along with the registration, and have the plugin
resolve virtual host → backend. Velocity has no runtime API for forced-hosts, so
this belongs in the plugin rather than in `velocity.toml`.

### 4.4 The forwarding decision

`velocity.toml` sets `player-info-forwarding-mode = "none"`. Joining through a
proxy with forwarding off means backends see the proxy's IP and cannot do
online-mode properly.

Making the proxy the real front door means:

- Velocity modern forwarding, with the secret distributed to backends.
- `online-mode=false` in every backend's `server.properties`, written by the
  daemon.
- **Firewalling the backend ports.** Without this, anyone connecting straight to
  `node:24001` can claim any username.

This is a security decision rather than a config tweak, and it is the reason
Phase 2 is larger than it looks. It also removes the direct-connection path that
Phase 1 serves — see §2.

---

## 5. What building Phase 1 turned up

Four things the plan did not anticipate, all found by the tests rather than by reading:

- **`server.close()`'s callback waits for connections, not for the port.** Awaiting it
  deadlocked the wake outright — the held player was deliberately never going to
  leave, so the callback never fired and the server never started. The call itself
  releases the listening handle, so it must not be awaited.
- **Clearing "stray" sockets on wake killed real players.** A player who had connected
  but whose first packet had not arrived yet is indistinguishable from a status ping.
  Nothing is destroyed there now; status pings end themselves and silent sockets are
  dropped by the idle timeout.
- **A dropped player leaked a socket to the server.** `pipe()` forwards a graceful end,
  and a client that crashes or loses its connection does not send one. Both directions
  now close together.
- **The readiness probe is the server's first connection, not the player's.** Anything
  counting connections — including a test — sees it. Harmless in production, one
  connect-and-close per wake.

The one thing still unverified is the client-side login timeout (§3.2). The keepalive
was implemented rather than measured against, so the number matters less than it did,
but it has still never been observed.

## 8. What building Phase 2 turned up

Three things the plan did not have, found by working through what actually happens to a
player rather than by reading the plugin:

- **Registration was tied to start and stop, so a stopped server did not exist.** The proxy
  is told about a server when it starts and told to forget it when it stops — and a stopped
  server is precisely the one somebody is trying to reach when they want it woken. There was
  no route to the thing the whole feature is about. Registration now covers every server
  regardless of state, and only deletion unregisters.
- **Nothing re-registered after a proxy restart.** The proxy keeps routes in memory only, so
  a restart left it empty until every server was manually restarted. The monitor tick now
  re-registers everything each pass, which repairs it within one tick.
- **The proxy had no way to ask for a wake.** `RegisteredServer.ping()` is a status ping, and
  the sleeper deliberately does not wake on those — otherwise every refresh of a server list
  would boot the whole node. The plugin sends a handshake with next-state 2 and closes
  (`WakeRequest.java`), which is the same signal a joining player gives, and the only one the
  sleeper accepts. No new endpoint and no shared secret.

And one decision the plan left open, taken here: **a backend that answers nothing at all gets
a 30-second wait, not ten minutes.** No answer means no sleeper holding the port, which means
nothing in reach can start that server. Ten minutes in a limbo world is a worse way to learn
that than being told to go and start it in the panel.

§4.4 — the forwarding mode, and firewalling the backend ports — is untouched. It is a
security decision with a migration attached, not a config change, and half of it is worse
than none: `player-info-forwarding-mode = "modern"` without `online-mode=false` written to
every backend breaks joining outright.

## 6. Order of work

1. **Measure the client login timeout.** One experiment; §3.2 depends on the
   answer.
2. **Phase 1 without the keepalive.** Fixes vanilla wake-up completely.
3. **Add the login-plugin keepalive.** Extends Phase 1 to modpacks.
4. **Phase 2**, when routing every player through one port is actually wanted.

Steps 2 and 3 are likely to cover most of what is wanted from this work.

---

## 7. Open questions

- What is the client's real login-state timeout, per version? (§3.2)
- Should waking stay implicit — triggered by a login attempt — or become an
  explicit panel call, so the proxy path does not depend on kick semantics?
- Do backend ports get firewalled, and if so how are direct-connect players
  migrated to the proxy hostname? (§4.4)
