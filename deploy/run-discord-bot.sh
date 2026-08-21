#!/bin/bash
#
# Creates or recreates the CraftControl Discord bot container on the Unraid box.
#
# This exists because Unraid's Add Container form refuses to populate from a
# hand-written template, and a container created by a bare `docker run` typed into a
# shell has its only description inside itself -- which is exactly how the bot was lost
# when watchtower removed it and had nothing to rebuild from.
#
# So the configuration lives in an env file on the flash drive, outside the container,
# and this script is the one way the container is made. Losing the container costs a
# rerun of this script; nothing else.
#
# Secrets sit in plaintext on /boot, the same place Unraid already keeps every other
# container's secrets in its dockerMan templates. No worse, and no better -- keep the
# flash backup private.
#
# Invoke through bash, not as ./run-discord-bot.sh: this lives on /boot, which is the
# FAT32 flash drive and carries no execute bit, so chmod +x on it succeeds and changes
# nothing.
#
# Usage:  bash /boot/config/run-discord-bot.sh
set -euo pipefail

ENV_FILE=/boot/config/craftcontrol-discord-bot.env
IMAGE=ghcr.io/retr0777/mc-hosting:discord-bot
# Matches the CONTAINERS parameter in Jenkinsfile, so a future deploy stage finds it.
NAME=craftcontrol-discord-bot

if [ ! -f "$ENV_FILE" ]; then
  cat >&2 <<MSG
No config at $ENV_FILE.

Create it with the five values below, then run this again. Nothing is created until it
exists -- a bot started with a blank token exits on boot and leaves a container that
looks present and answers nothing.

  DISCORD_BOT_TOKEN=      # Developer Portal > your app > Bot > Reset Token
  DISCORD_CLIENT_ID=      # Developer Portal > your app > General Information
  DISCORD_GUILD_ID=       # your server's ID; blank registers globally and takes an hour
  WEB_API_URL=http://192.168.50.220:3000
  DISCORD_BOT_SECRET=     # must equal the panel's own DISCORD_BOT_SECRET

MSG
  exit 1
fi

chmod 600 "$ENV_FILE"

# Read without sourcing: a stray quote or space in a pasted token should produce a bot
# that fails to log in, not shell that runs whatever the token happened to contain.
get() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- ; }

TOKEN=$(get DISCORD_BOT_TOKEN)
CLIENT_ID=$(get DISCORD_CLIENT_ID)
GUILD_ID=$(get DISCORD_GUILD_ID)
API_URL=$(get WEB_API_URL)
BOT_SECRET=$(get DISCORD_BOT_SECRET)

missing=()
[ -n "$TOKEN" ]      || missing+=(DISCORD_BOT_TOKEN)
[ -n "$CLIENT_ID" ]  || missing+=(DISCORD_CLIENT_ID)
[ -n "$API_URL" ]    || missing+=(WEB_API_URL)
[ -n "$BOT_SECRET" ] || missing+=(DISCORD_BOT_SECRET)
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing in $ENV_FILE: ${missing[*]}" >&2
  exit 1
fi

# The container name is the panel's hostname on the docker network too, so a stale one
# left behind would take the name and the new one would fail to start.
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker pull "$IMAGE"

docker run -d \
  --name "$NAME" \
  --restart always \
  -e DISCORD_BOT_TOKEN="$TOKEN" \
  -e DISCORD_CLIENT_ID="$CLIENT_ID" \
  -e DISCORD_GUILD_ID="$GUILD_ID" \
  -e WEB_API_URL="$API_URL" \
  -e DISCORD_BOT_SECRET="$BOT_SECRET" \
  "$IMAGE"

echo
echo "Created $NAME. The bot registers its slash commands on boot; watch for that:"
echo "  docker logs -f $NAME"
