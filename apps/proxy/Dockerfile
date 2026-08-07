# Stage 1: Build the plugin
FROM gradle:8.5-jdk17 AS builder
WORKDIR /app
COPY apps/proxy-plugin /app
RUN gradle build --no-daemon

# Stage 2: Run Velocity
FROM itzg/bungeecord

ENV TYPE=VELOCITY
ENV VELOCITY_VERSION=latest

# Copy the built plugin from Stage 1
COPY --from=builder /app/build/libs/proxy-plugin-1.0-SNAPSHOT.jar /plugins/mcmanager-proxy.jar
COPY --from=builder /app/build/libs/proxy-plugin-1.0-SNAPSHOT.jar /server/plugins/mcmanager-proxy.jar
COPY apps/proxy/velocity.toml /server/velocity.toml
COPY apps/proxy/forwarding.secret /server/forwarding.secret

# Configuration for Velocity will be provided via volume or env vars
