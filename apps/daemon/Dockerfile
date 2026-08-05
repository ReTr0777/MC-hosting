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

# Build shared package first, then daemon
RUN npm run --prefix packages/shared build
RUN npm run --prefix apps/daemon build

# Production Runner Image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV DAEMON_PORT=3500
ENV DAEMON_DATA_DIR=/app/apps/daemon/data
ENV SERVERPACKCREATOR_JAR=/opt/serverpackcreator/serverpackcreator.jar

# Install OpenJDK 21 & curl/unzip/bash for ServerPackCreator CLI
RUN apk add --no-cache openjdk21-jre-headless curl unzip bash

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
