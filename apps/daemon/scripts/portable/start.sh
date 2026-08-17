#!/bin/sh
#
# Starts the MC Hosting node.
#
# Run it as `sh start.sh` so it works regardless of how /bin/sh resolves — Termux
# rewrites shebangs through termux-exec, but only when that is installed, and a
# confusing "not found" on the very first command is a bad way to begin.

set -e

# Everything is resolved from the bundle directory rather than the caller's, so the
# node finds its own files whether it was started from here, from $HOME, or by a
# Termux boot script.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$dir"

# Settings live in daemon.env when there are any. Without it the node generates a
# setup password on first run and everything else is done through the setup page.
if [ -f "$dir/daemon.env" ]; then
  set -a
  . "$dir/daemon.env"
  set +a
fi

# Worlds and config.json go beside the bundle by default. config.json is written to
# the *parent* of this path, so both land under data/.
: "${DAEMON_DATA_DIR:=$dir/data/servers}"
export DAEMON_DATA_DIR

# The tunnel client, if this bundle shipped with one. The daemon runs fine without
# it — that costs the tunnel and nothing else.
if [ -z "$FRPC_PATH" ] && [ -x "$dir/frpc" ]; then
  export FRPC_PATH="$dir/frpc"
fi

# node-unrar-js travels as a real package because its wasm loads relative to its own
# directory, so the bare require it does has to resolve somewhere.
export NODE_PATH="$dir/vendor${NODE_PATH:+:$NODE_PATH}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH. In Termux: pkg install nodejs-lts" >&2
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Warning: java is not on PATH, so Minecraft servers will fail to start." >&2
  echo "         In Termux: pkg install openjdk-21" >&2
fi

# Android reclaims memory from backgrounded apps, and a node that is killed whenever
# the user opens another app is not a node. The wakelock is what stops that, and it
# is the single most common reason a phone node "randomly" disappears.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT INT TERM
fi

exec node "$dir/index.js"
