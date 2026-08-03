# Multi-stage Dockerfile for CraftControl Next.js Web Panel
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

# Copy monorepo manifests
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN npm install

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Ensure public directory exists
RUN mkdir -p /app/apps/web/public

# Build shared types package
RUN npm run --prefix packages/shared build

# Generate Prisma Client & Build Next.js Standalone
RUN npm run --prefix apps/web prisma:generate
RUN npm run --prefix apps/web build

# Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000

# Copy standalone output from Next.js builder
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
