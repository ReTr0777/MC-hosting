# MC Hosting Node — portable bundle

A node agent that runs without Docker. Everything it needs is in this directory
except Node.js and Java, which come from your package manager.

Built for Android/Termux, but nothing here is Android-specific — it works the same
on a Raspberry Pi, an ARM VPS, or any Linux box where installing Docker is not worth
the trouble.

## Servers run as processes, not containers

The panel offers two execution modes. This bundle only supports **Standalone
Process**, which is the default when you create a server, so in practice there is
nothing to change. Docker Container mode needs a Docker daemon and will fail here.

The node reports `dockerAvailable: false` and a status of `degraded`. That is
expected and does not affect anything — the panel shows it as online and every
process-mode feature works.

## Setup on Android (Termux)

Install Termux from **F-Droid**, not the Play Store. The Play Store build was
abandoned years ago and its packages are too old to install Node 20.

```sh
pkg update
pkg install nodejs-lts openjdk-21
```

Then unpack this bundle and start it:

```sh
tar -xzf mc-hosting-node-*-linux-arm64.tar.gz
cd mc-hosting-node
sh start.sh
```

The first run prints a setup password. Open `http://<phone's IP>:3500/` from a
computer on the same network, enter it, and fill in the daemon API key you want this
node to use. Then add the node in the panel with that same key.

To find the phone's IP: `ifconfig` in Termux, or check the router.

### Keeping it alive

Android kills background processes aggressively, and this is the main reason a phone
node goes offline for no visible reason.

1. `pkg install termux-api` — `start.sh` then takes a wakelock automatically.
2. Android settings → Apps → Termux → Battery → **Unrestricted**.
3. In Termux: Settings → **Acquire wakelock** on the notification.

Even with all three, expect the occasional kill. Restarting it is `sh start.sh`.

## Configuration

Anything the setup page writes goes to `data/config.json`. For unattended starts you
can instead create `daemon.env` next to `start.sh`:

```sh
DAEMON_API_KEY=your-key-here
DAEMON_PORT=3500
FRP_SERVER_ADDR=tunnel.example.com
FRP_SERVER_PORT=7000
FRP_TOKEN=your-frp-token
FRP_DAEMON_API_PORT=3502
```

`config.json` wins over `daemon.env` for anything set in both.

### If the phone is on mobile data

It is behind carrier NAT, so the panel cannot connect to it directly no matter what
you forward. Set `FRP_SERVER_ADDR`/`FRP_TOKEN` and `FRP_DAEMON_API_PORT` — the node
publishes its own API back through the tunnel, and the panel reaches it there.

`frpc` in this directory is picked up automatically.

## What to expect from a phone

An S10-class device runs a vanilla or light-Fabric server for a handful of players.
Expect to be limited by heat before RAM: sustained JVM load throttles the SoC, and
the phone gets hot enough to matter. Large modpacks are not realistic.

Java is the other constraint — Termux ships OpenJDK 17 and 21, so Minecraft versions
that require Java 25 will not run.

## Storage

Worlds live in `data/servers/`. On Termux that is inside the app's private storage,
which means **uninstalling Termux deletes them**. Back up anything you care about, or
point `DAEMON_DATA_DIR` at `~/storage/shared` after running `termux-setup-storage`.
