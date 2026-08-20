# Running a Node.js game-server agent on a Galaxy S10 — briefing

You are being asked about the **Android side only**. The software is already built
and is not the thing under question; what follows is everything about it you need in
order to answer, and then the specific questions.

## The device

- Samsung Galaxy S10 (2019), **unrooted**, stock firmware.
- Last official Android is **12 / One UI 4.1**.
- Exynos 9820 or Snapdragon 855 depending on region, arm64, 8 GB RAM.
- Intended to sit at home, plugged in, running continuously.

Assume no root and no custom ROM. If an answer requires either, say so explicitly
rather than assuming it is available.

## What has to run

A **Node.js process** (the "node agent") that:

1. Binds an HTTP + WebSocket server on port **3500** and must accept connections
   from other machines on the LAN.
2. **Spawns `java` child processes** — one long-lived JVM per game server, expected
   to run for days. It writes to their stdin and reads stdout continuously.
3. Optionally spawns **one `frpc` child process** (a Go binary, reverse tunnel
   client) that holds an outbound TCP connection open indefinitely.
4. Reads and writes a data directory continuously — game worlds, config JSON, logs.
5. Must survive the phone being idle, screen off, and other apps being used.

It does **not** need root, does not need to listen on a privileged port, and does
not need Docker (see below).

## What has already been decided and built

Do not re-litigate these; they are settled and working:

- **Docker is out.** Android's kernel ships without the cgroup/overlayfs support
  Docker needs and there is no root to enable it. `proot-distro` gives a Debian
  arm64 userland but proot fakes chroot in userspace and cannot provide namespaces,
  so Docker cannot run inside it either. The agent has a Docker-free execution mode
  and that is what will be used.
- **Distribution is solved.** A 6.1 MB `.tar.gz` for `linux-arm64` containing a
  single pre-bundled `index.js`, a `public/` directory, one vendored npm package,
  an arm64 `frpc` binary, and a `start.sh`. **Nothing is installed via npm on the
  device** — deliberately, because npm install under Termux is slow and native
  addon builds fail. Assume the files simply appear in `~/mc-hosting-node/`.
- **Termux from F-Droid**, not the Play Store build.
- The launcher already: resolves its own directory, sources an optional
  `daemon.env`, exports `NODE_PATH` for the vendored package, points `FRPC_PATH` at
  the bundled binary, warns if `node` or `java` is missing, and calls
  `termux-wake-lock` (with a trap to release it) when `termux-api` is present.

## What the agent needs from the environment

| Need | Currently assumed |
|---|---|
| Node.js runtime | `pkg install nodejs-lts` (needs Node 20+) |
| Java | `pkg install openjdk-21`, falling back to 17 |
| `java` location | plain `java` on `PATH`, or the `JAVA_BIN` env var if elsewhere |
| Executable bit | `frpc` and `start.sh` ship as `0755` inside the tarball |
| Writable data dir | defaults to `~/mc-hosting-node/data/` |

## Questions

Answer these specifically for **Android 12, unrooted, Termux from F-Droid**. Where
something changed across Android or Termux versions, say which version.

### 1. The phantom process killer — the one I am most worried about

Android 12 introduced a limit on child processes spawned by an app, and kills them
once the app exceeds it. The agent's whole design is spawning long-lived children:
one JVM per game server, plus `frpc`.

- Does this actually apply to Termux child processes on One UI 4.1?
- What is the current limit, and does a JVM count as one process or several?
- The mitigation I know of is `adb shell settings put global
  settings_enable_monitor_phantom_procs false` — does that still work on Android 12,
  does it survive a reboot, and is there anything that does not require a PC and
  ADB cable?
- Is there a way to detect from inside Termux that this is what killed a process,
  so the agent could log something useful instead of "the server vanished"?

### 2. Keeping it alive

Beyond `termux-wake-lock` and setting Termux to Unrestricted battery on Samsung:

- Does One UI's own aggressive app management ("Put unused apps to sleep",
  "Auto-optimise daily") need separate handling? Samsung is stricter than AOSP here.
- Is `termux-boot` reliable on One UI 4.1 for restarting the agent after a reboot,
  and does it require the app to have been opened once first?
- Realistically, what uptime is achievable? Days, or hours?

### 3. Executing the bundled binaries

`frpc` is a Go binary shipped inside the tarball and executed from Termux's home
directory.

- Does executing a downloaded binary from `$HOME` work on Android 12 with current
  Termux, or does W^X / the API-29 exec restriction interfere?
- Is `termux-exec` required for this, and is it installed by default?
- Same question for `start.sh` and its `#!/bin/sh` shebang — the instructions say to
  run `sh start.sh` to sidestep shebang resolution. Is that necessary or paranoid?

### 4. Java

- Which OpenJDK packages does the Termux arm64 repo actually offer right now? I have
  assumed 17 and 21 are both available and am not confident about 21.
- Any known problems running a long-lived server JVM under Termux — signal handling,
  `Runtime.availableProcessors`, memory limits, JIT on arm64?
- Anything to be said for `-XX:` flags specific to a phone SoC with big.LITTLE cores?

### 5. Storage

Worlds are written continuously and are the only thing on the device worth keeping.

- Termux app-private storage is deleted when Termux is uninstalled. Is
  `termux-setup-storage` + `~/storage/shared` a safe alternative for a directory a
  JVM writes to constantly, or does the FUSE/scoped-storage layer break file locking,
  `fsync`, renames, or permissions?
- Is there a meaningful write-endurance concern running a game server on phone flash
  for months?

### 6. Networking

- Can a Termux process bind `0.0.0.0:3500` and accept LAN connections on Android 12
  without extra permissions?
- Does Doze or the Wi-Fi power-save state drop idle inbound sockets or the outbound
  tunnel connection when the screen is off, and if so what keeps them alive?
- Anything to know about Wi-Fi behaviour while charging overnight — some Samsungs
  drop to a low-power Wi-Fi state.

### 7. Thermals and expectations

Plugged in and running a JVM continuously, with the phone likely lying flat.

- What sustained CPU load is realistic on an S10 before thermal throttling, and does
  charging while loaded make it materially worse?
- Is battery swelling a genuine risk for a device kept at 100% and warm for months,
  and does One UI have a charge limit that helps?

## Output I want

Concrete and Android-specific: exact commands, exact settings paths, and where
something is not possible without root or ADB, say so plainly. Please flag anything
above that I have assumed and got wrong.
