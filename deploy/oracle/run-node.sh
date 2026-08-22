#!/bin/bash
#
# Creates, recreates, or updates the CraftControl daemon node on an Oracle Cloud
# instance (or any other plain Docker host).
#
# This is the same shape as run-discord-bot.sh, and for the same reason: the
# configuration lives in an env file outside the container, so the container is
# reproducible from something other than itself. A container created by a bare
# `docker run` typed into a shell describes its own configuration only internally,
# and that is exactly how the Discord bot was lost when watchtower removed it and
# had nothing to rebuild from. Losing this container costs a rerun of this script.
#
# Watchtower is deliberately not used here. It would need its own ghcr credentials
# and would recreate the container from the running container's config -- the same
# arrangement that failed before. A pull plus this script is the whole job.
#
# Usage:
#   bash run-node.sh          # pull, and recreate only if the image actually changed
#   bash run-node.sh --force  # recreate against the current image regardless
#
# Run it on a timer for unattended updates; see craftcontrol-node.timer.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/craftcontrol/node.env}
IMAGE=ghcr.io/retr0777/mc-hosting:daemon
# Matches the CONTAINERS parameter in Jenkinsfile, so a future deploy stage finds it.
NAME=craftcontrol-daemon

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ ! -f "$ENV_FILE" ]; then
  cat >&2 <<MSG
No config at $ENV_FILE.

Copy craftcontrol-node.env.example there and fill it in, then run this again.
Nothing is created until it exists -- a daemon started with a blank API key answers
every panel request with 401 and looks, from the panel, exactly like a network fault.

  install -d -m 700 /etc/craftcontrol
  cp craftcontrol-node.env.example $ENV_FILE
  \$EDITOR $ENV_FILE

MSG
  exit 1
fi

chmod 600 "$ENV_FILE"

# Read without sourcing: a stray quote or space in a pasted key should produce a daemon
# that fails to authenticate, not shell that runs whatever the key happened to contain.
#
# `|| true` is load-bearing under `set -o pipefail`: a key that is absent from the file
# entirely makes grep exit 1, which fails the whole pipeline and, with `set -e`, kills
# the script mid-read with no message at all. Most of the keys here are optional, so
# that is the normal case rather than an edge one.
get() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true ; }

API_KEY=$(get DAEMON_API_KEY)
DAEMON_PORT=$(get DAEMON_PORT)
DAEMON_DATA=$(get DAEMON_DATA)
PORT_RANGE=$(get SERVER_PORT_RANGE)
FRP_ADDR=$(get FRP_SERVER_ADDR)
FRP_PORT=$(get FRP_SERVER_PORT)
FRP_TOKEN=$(get FRP_TOKEN)
FRP_API_PORT=$(get FRP_DAEMON_API_PORT)

: "${DAEMON_PORT:=3500}"
: "${DAEMON_DATA:=/opt/craftcontrol/data}"
: "${PORT_RANGE:=24000-25000}"

if [ -z "$API_KEY" ]; then
  echo "Missing DAEMON_API_KEY in $ENV_FILE" >&2
  exit 1
fi

# The panel and this node must agree on the key, and the panel is where the node is
# added. A placeholder left in place is a slow, confusing failure, so refuse it here.
case "$API_KEY" in
  change-me*|change-this*|default-daemon-secret-key)
    echo "DAEMON_API_KEY in $ENV_FILE is still the placeholder. Set a real key." >&2
    exit 1
    ;;
esac

mkdir -p "$DAEMON_DATA/servers"

# What is running right now, so an update that changes nothing changes nothing. The
# node restarting drops its websocket to the panel and blinks the card offline; on a
# nightly timer that is worth avoiding when there is no new image to take.
running_image=$(docker inspect --format '{{.Image}}' "$NAME" 2>/dev/null || echo none)

docker pull "$IMAGE"
pulled_image=$(docker inspect --format '{{.Id}}' "$IMAGE")

if [ "$FORCE" -eq 0 ] && [ "$running_image" = "$pulled_image" ]; then
  echo "$NAME is already running $IMAGE ($(echo "$pulled_image" | cut -c8-19)). Nothing to do."
  exit 0
fi

# The container name is also its hostname on any docker network it joins, so a stale
# one left behind would take the name and the new one would fail to start.
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Assembled as an array so an empty optional value cannot collapse into the wrong
# argument position.
args=(
  --name "$NAME"
  --restart always
  -p "${DAEMON_PORT}:3500"
  # The range game servers are allocated from. Published up front because the daemon
  # hands ports out at runtime, long after this script has exited.
  -p "${PORT_RANGE}:${PORT_RANGE}"
  -p "${PORT_RANGE}:${PORT_RANGE}/udp"
  -v /var/run/docker.sock:/var/run/docker.sock
  # /app/data, not /app/apps/daemon/data: the latter is not where the daemon looks, and
  # mounting there persists nothing while leaving the node apparently fine until the
  # first restart takes every world with it.
  -v "${DAEMON_DATA}:/app/data"
  -e DAEMON_API_KEY="$API_KEY"
  -e DAEMON_PORT=3500
  # The host path that appears inside the daemon as its own server directory: the
  # volume mounted at /app/data, plus the `servers` subdirectory the daemon keeps them
  # in. Get this wrong and the daemon and each game container look at different
  # directories -- exports tar an empty one, and installed mods land where nothing
  # reads them.
  -e HOST_DATA_DIR="${DAEMON_DATA}/servers"
)

# An Oracle instance has a routable public IP, so the panel can reach it directly and
# the tunnel is optional -- unlike a node behind NAT, which has no other way in. Set
# these only to avoid exposing the daemon port publicly, or if you have put the node
# on a private subnet.
if [ -n "$FRP_ADDR" ]; then
  args+=(-e FRP_SERVER_ADDR="$FRP_ADDR")
  args+=(-e FRP_SERVER_PORT="${FRP_PORT:-7000}")
  [ -n "$FRP_TOKEN" ] && args+=(-e FRP_TOKEN="$FRP_TOKEN")
  [ -n "$FRP_API_PORT" ] && args+=(-e FRP_DAEMON_API_PORT="$FRP_API_PORT")
fi

docker run -d "${args[@]}" "$IMAGE"

echo
echo "Created $NAME on $IMAGE ($(echo "$pulled_image" | cut -c8-19))."
echo "Check it answers before adding it in the panel:"
echo "  curl -s localhost:${DAEMON_PORT}/ping"
echo "  docker logs -f $NAME"
