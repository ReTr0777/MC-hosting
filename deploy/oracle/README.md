# CraftControl node on Oracle Cloud Free Tier

Runs the daemon as a Docker container on an Always Free Ampere instance, updated by a
nightly `docker pull` rather than by hand.

Nothing here is Oracle-specific except the firewall section — the same three files work
on any plain Docker host. Oracle earns its own directory because of that firewall.

## Pick the ARM shape

Always Free gives you **4 Ampere A1 OCPUs and 24 GB RAM**, which you can split across up
to four instances. The other Always Free option, two AMD micro VMs at 1 GB RAM each,
will not host a Minecraft server — ignore it.

A1 is **aarch64**, and that is the one thing that shapes the rest of this.

Two practical warnings:

- **"Out of host capacity"** on A1 is extremely common on free accounts, and it is a real
  capacity limit rather than something you can retry your way past quickly. Upgrading to
  Pay As You Go clears it in most regions and still bills $0 for Always Free resources.
- **Idle instances get reclaimed.** Oracle reclaims Always Free compute that sits unused.
  A node with servers running on it is fine; one you provision and leave empty may
  disappear.

Give the instance a **reserved public IP**, not the default ephemeral one. An ephemeral
IP changes when the instance is stopped and started, and the panel would go on trying to
reach the old address with no indication of why the node died.

## The image must be built for arm64 first

`Jenkinsfile` defaults `PLATFORMS` to `linux/amd64`. Run the pipeline once with:

    PLATFORMS = linux/amd64,linux/arm64

Until that build lands, `ghcr.io/retr0777/mc-hosting:daemon` is x86-only and will not
start here. The build is noticeably slower, since the arm64 half runs under emulation.

`apps/daemon/Dockerfile` reads buildx's `TARGETARCH` and picks the right JDK, `frpc` and
`unrar` for each architecture. One difference is worth knowing: RARLAB publishes no Linux
ARM binary, so arm64 gets Debian's `unrar` 6.2.6 from non-free instead of the pinned 7.23.
Both decode RAR5 in full, so modpack extraction behaves the same.

## Install

The package is public, so the instance needs no `docker login`.

```sh
# Docker, if the image does not have it
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker

# The update script and its configuration
sudo install -m 755 run-node.sh /usr/local/bin/run-node.sh
sudo install -d -m 700 /etc/craftcontrol
sudo install -m 600 craftcontrol-node.env.example /etc/craftcontrol/node.env
sudo openssl rand -hex 32   # paste into DAEMON_API_KEY
sudoedit /etc/craftcontrol/node.env

# First run
sudo run-node.sh
curl -s localhost:3500/ping
```

Then add the node in the panel using the same `DAEMON_API_KEY`, addressed as
`<reserved public IP>:3500`.

## Open the firewall

Oracle filters in two places, but only one of them is always required, and the
difference is worth understanding before you start editing rules.

### 1. VCN ingress rules — always required

Networking -> your VCN -> the subnet's security list. Add ingress from `0.0.0.0/0`
for TCP 3500 and for TCP + UDP 24000-25000.

Nothing reaches the instance until this is done.

### 2. The instance's own iptables — usually not the problem

Oracle's Ubuntu and Oracle Linux images ship with rules that reject everything except
SSH, which is why "also fix iptables" is the standard advice for OCI. For **Docker
published ports it does not apply**: Docker DNATs those packets in PREROUTING and
filters them in the FORWARD chain via its own DOCKER chain, so they never traverse
INPUT and the image's REJECT rule never sees them.

So open the VCN rules and **test before touching iptables at all**, from another
machine rather than from the instance:

```sh
nc -vz <public IP> 3500
```

If that succeeds, you are done -- leave the host firewall as it is. Adding rules you
did not need is how a working setup acquires a second thing to debug later.

If it fails, the host firewall is in the path after all (a host-level service rather
than a container, or a modified ruleset). On Ubuntu images, insert *before* the
catch-all REJECT rather than at a guessed position -- check where that is first:

```sh
sudo iptables -L INPUT --line-numbers      # find the REJECT line number, call it N
sudo iptables -I INPUT N -p tcp --dport 3500 -j ACCEPT
sudo iptables -I INPUT N -p tcp --dport 24000:25000 -j ACCEPT
sudo iptables -I INPUT N -p udp --dport 24000:25000 -j ACCEPT
sudo netfilter-persistent save
```

On Oracle Linux images, which use firewalld:

```sh
sudo firewall-cmd --permanent --add-port=3500/tcp
sudo firewall-cmd --permanent --add-port=24000-25000/tcp
sudo firewall-cmd --permanent --add-port=24000-25000/udp
sudo firewall-cmd --reload
```

If you would rather not expose 3500 at all, set `FRP_SERVER_ADDR`, `FRP_TOKEN` and
`FRP_DAEMON_API_PORT` in `node.env` and open only the game port range. The node then
publishes its API back through the tunnel and the panel reaches it there -- the same
arrangement a NAT'd home node needs, used here by choice rather than necessity.

Outbound traffic is 10 TB/month free, so player bandwidth is not a concern.

## Keeping it updated

`Jenkinsfile` pushes both `:daemon` and `:daemon-b<N>` on every build, so the plain
`:daemon` tag moves and a pull picks up new versions.

```sh
sudo install -m 644 craftcontrol-node-update.service craftcontrol-node-update.timer \
    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now craftcontrol-node-update.timer
```

That pulls nightly at 05:00 and **recreates the container only when the image actually
changed** — a pull that finds nothing new leaves the running node untouched, so the
node does not blink offline every night for no reason.

```sh
systemctl list-timers craftcontrol-node-update.timer   # when it next runs
journalctl -u craftcontrol-node-update.service         # what it did
sudo run-node.sh                                       # update now
sudo run-node.sh --force                               # recreate regardless
```

Prefer to pick the moment yourself? Skip `enable --now` on the timer and run
`sudo run-node.sh` when no one is playing. Updating restarts the agent, which blinks the
node offline in the panel for a few seconds; the game servers are separate containers
with their own restart policies and keep running throughout.

## Backups

`DAEMON_DATA` (default `/opt/craftcontrol/data`) holds every world, plus `config.json`
and `frpc.toml`. It is the only thing on the instance that is not reproducible from the
image and this directory.

**Boot volume backups are not covered by Always Free.** The 200 GB allowance is block
*storage*; backups are written to Object Storage, where the free allowance is 20 GB
(10 GB standard plus 10 GB archive). A backup of a 200 GB boot volume passes that on the
first run, and on a Pay As You Go account the excess is simply billed rather than
refused. An OCI backup policy on this volume is a recurring charge, not a free one.

Cheaper options that stay inside the free tier:

- The daemon's own S3 backups (`s3Endpoint` and friends in the daemon config) point at
  any S3-compatible bucket, including one outside Oracle.
- `tar` the worlds you care about and pull them off with `rsync`/`scp` on a timer.
- Back up only what is irreplaceable -- worlds -- rather than the whole boot volume.
  Everything else here is reproducible from the image plus `node.env`.

If the container is ever lost, rerun `run-node.sh`. That is the whole point of keeping
the configuration in `/etc/craftcontrol/node.env` rather than inside the container.

## What a free A1 will actually run

4 OCPUs and 24 GB is genuinely capable — far more than the phone nodes in
`apps/daemon/scripts/portable/README.md`. Expect to run several vanilla or Fabric servers
comfortably, or one large modpack. Ampere cores are individually slower than modern x86
under a single-threaded load, which is most of what a Minecraft tick is, so a heavily
modded server with many players will feel the difference before it runs out of RAM.
