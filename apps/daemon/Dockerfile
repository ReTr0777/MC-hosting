# Multi-stage Dockerfile for CraftControl Worker Daemon Node
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root and workspace package manifests
COPY package.json ./
COPY package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/daemon/package.json ./apps/daemon/

# Install dependencies from package-lock.json for reproducible builds
RUN npm ci

# Copy source files
COPY packages/shared ./packages/shared
COPY apps/daemon ./apps/daemon
COPY apps/web/prisma ./apps/web/prisma

# Generate Prisma Client & Build shared package first, then daemon
RUN npx prisma generate --schema apps/web/prisma/schema.prisma
RUN npm run --prefix packages/shared build
RUN npm run --prefix apps/daemon build

# Production Runner Image with native glibc
FROM node:20-slim AS runner

# Supplied automatically by buildx as amd64 or arm64. Every download below is
# architecture-specific, so a build that ignored this produced an arm64 image full of
# x86 binaries: it starts, then every archive extraction and every Java launch fails.
ARG TARGETARCH

WORKDIR /app

ENV NODE_ENV=production
ENV DAEMON_PORT=3500
# The deployment must mount its host directory at /app/data, the parent of this: the
# daemon keeps its servers here and its config.json and frpc.toml one level up.
ENV DAEMON_DATA_DIR=/app/data/servers
ENV SERVERPACKCREATOR_JAR=/opt/serverpackcreator/serverpackcreator.jar

# Install required system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl zip unzip unrar-free p7zip-full bash ca-certificates psmisc procps lsof iproute2 net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install the real RARLAB `unrar` binary. `unrar-free` (installed above) is a clean-room
# reimplementation that cannot decode many modern RAR5 compression methods/filters, which
# silently drops files ("Unsupported Method") out of large modpack archives during extraction.
# The official binary has full RAR5 support and is freeware for extraction use.
#
# RARLAB ships a Linux binary for x64 only -- its sole ARM build is for macOS -- so
# arm64 installs Debian's `unrar` from non-free, which is that same RARLAB source
# compiled. It is 6.2.6 rather than 7.23 and still decodes RAR5 in full. amd64 keeps
# the pinned binary it has always used, so nothing changes for the image in use today.
RUN set -eux; \
    if [ "$TARGETARCH" = "amd64" ]; then \
        curl -sSLf "https://www.rarlab.com/rar/rarlinux-x64-723.tar.gz" -o /tmp/rar.tar.gz && \
        tar -xzf /tmp/rar.tar.gz -C /tmp && \
        cp /tmp/rar/unrar /usr/local/bin/unrar && \
        chmod +x /usr/local/bin/unrar && \
        rm -rf /tmp/rar.tar.gz /tmp/rar; \
    else \
        echo 'deb http://deb.debian.org/debian bookworm non-free' > /etc/apt/sources.list.d/non-free.list && \
        apt-get update && \
        apt-get install -y --no-install-recommends unrar && \
        rm -rf /var/lib/apt/lists/*; \
    fi; \
    unrar 2>&1 | head -n 1

# Download & Install Java 17, Java 21, and Java 25 runtimes for complete Minecraft compatibility
# Adoptium names the architectures x64 and aarch64, neither of which matches
# TARGETARCH. -f matters here: without it curl writes the HTML error page into the
# tarball, and a bad download surfaces later as an unreadable archive instead.
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) jdk_arch=x64 ;; \
        arm64) jdk_arch=aarch64 ;; \
        *) echo "no JDK mapping for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    for spec in "17 ga eclipse" "21 ga eclipse" "25 ea adoptium"; do \
        set -- $spec; ver=$1; rel=$2; vendor=$3; \
        mkdir -p "/opt/java/openjdk-$ver"; \
        curl -sSLf "https://api.adoptium.net/v3/binary/latest/$ver/$rel/linux/$jdk_arch/jdk/hotspot/normal/$vendor" -o /tmp/jdk.tar.gz; \
        tar -xzf /tmp/jdk.tar.gz -C "/opt/java/openjdk-$ver" --strip-components=1; \
        rm -f /tmp/jdk.tar.gz; \
        "/opt/java/openjdk-$ver/bin/java" -version; \
    done

ENV JAVA_HOME=/opt/java/openjdk-21
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Pre-bundle popular server executables into /opt/minecraft-jars for 0ms instant startup
RUN mkdir -p /opt/minecraft-jars && \
    curl -sSLL "https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.3/1.0.1/server/jar" -o /opt/minecraft-jars/fabric-26.2.jar && \
    curl -sSLL "https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.19.3/1.0.1/server/jar" -o /opt/minecraft-jars/fabric-1.20.1.jar && \
    curl -sSLL "https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.19.3/1.0.1/server/jar" -o /opt/minecraft-jars/fabric-1.21.4.jar

# Download verified ServerPackCreator 8.1.2 release JAR executable into /opt/serverpackcreator/serverpackcreator.jar
RUN mkdir -p /opt/serverpackcreator && \
    curl -sSLf "https://github.com/Griefed/ServerPackCreator/releases/download/8.1.2/ServerPackCreator-8.1.2.jar" -o /opt/serverpackcreator/serverpackcreator.jar

# Install Fast Reverse Proxy (frpc)
# frp uses the same architecture names as TARGETARCH, so this one needs no mapping.
# Keep the version in step with FRP_VERSION in apps/daemon/scripts/frp-download.mjs --
# the daemon writes a config whose format is tied to it.
RUN set -eux; \
    frp="frp_0.58.0_linux_${TARGETARCH}"; \
    curl -sSLf "https://github.com/fatedier/frp/releases/download/v0.58.0/${frp}.tar.gz" -o frp.tar.gz; \
    tar -xzf frp.tar.gz; \
    mv "${frp}/frpc" /usr/local/bin/frpc; \
    chmod +x /usr/local/bin/frpc; \
    rm -rf "${frp}" frp.tar.gz; \
    frpc --version

# Copy workspace package manifests & compiled outputs
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/daemon/package.json ./apps/daemon/
COPY --from=builder /app/apps/daemon/dist ./apps/daemon/dist
COPY apps/daemon/src/public ./apps/daemon/dist/public

# Copy installed node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3500

WORKDIR /app/apps/daemon

CMD ["node", "dist/index.js"]
