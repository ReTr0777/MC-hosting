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

WORKDIR /app

ENV NODE_ENV=production
ENV DAEMON_PORT=3500
ENV DAEMON_DATA_DIR=/app/data/servers
ENV SERVERPACKCREATOR_JAR=/opt/serverpackcreator/serverpackcreator.jar

# Install required system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip unrar-free p7zip-full bash ca-certificates psmisc procps lsof iproute2 net-tools \
    && rm -rf /var/lib/apt/lists/*

# Download & Install Java 17, Java 21, and Java 25 runtimes for complete Minecraft compatibility
RUN mkdir -p /opt/java/openjdk-17 && \
    curl -sSLL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk17.tar.gz && \
    tar -xzf /tmp/jdk17.tar.gz -C /opt/java/openjdk-17 --strip-components=1 && \
    rm -rf /tmp/jdk17.tar.gz

RUN mkdir -p /opt/java/openjdk-21 && \
    curl -sSLL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk21.tar.gz && \
    tar -xzf /tmp/jdk21.tar.gz -C /opt/java/openjdk-21 --strip-components=1 && \
    rm -rf /tmp/jdk21.tar.gz

RUN mkdir -p /opt/java/openjdk-25 && \
    curl -sSLL "https://api.adoptium.net/v3/binary/latest/25/ea/linux/x64/jdk/hotspot/normal/adoptium" -o /tmp/jdk25.tar.gz && \
    tar -xzf /tmp/jdk25.tar.gz -C /opt/java/openjdk-25 --strip-components=1 && \
    rm -rf /tmp/jdk25.tar.gz

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
RUN curl -sSLf "https://github.com/fatedier/frp/releases/download/v0.58.0/frp_0.58.0_linux_amd64.tar.gz" -o frp.tar.gz && \
    tar -xzf frp.tar.gz && \
    mv frp_0.58.0_linux_amd64/frpc /usr/local/bin/frpc && \
    chmod +x /usr/local/bin/frpc && \
    rm -rf frp_0.58.0_linux_amd64 frp.tar.gz

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
