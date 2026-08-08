# Multi-stage Dockerfile for CraftControl Next.js Web Panel
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

# Copy monorepo manifests
COPY package.json ./
COPY package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

# Install dependencies from package-lock.json for reproducible builds
RUN npm ci

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Ensure public directory exists
RUN mkdir -p /app/apps/web/public

# Build shared types package
RUN npm run --prefix packages/shared build

# Ensure DATABASE_URL dummy string for build-time Prisma Client generation & Next.js page collection
ENV DATABASE_URL="postgresql://mcuser:mcpassword@127.0.0.1:5432/mcmanager?schema=public"

# Generate Prisma Client & Build Next.js
RUN npm run --prefix apps/web prisma:generate
RUN npm run --prefix apps/web build

# Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000

# Copy built app output from Next.js builder
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/server.js ./apps/web/server.js

# Copy installed dependencies from builder so runtime can use the same Prisma version
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

CMD ["sh", "-c", "cd apps/web && npx prisma db push --accept-data-loss --schema prisma/schema.prisma && npm run start"]
