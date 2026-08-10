# Multi-stage Dockerfile for the CraftControl Discord bot
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY apps/discord-bot/package.json ./apps/discord-bot/

RUN npm ci

COPY apps/discord-bot ./apps/discord-bot

RUN npm run --prefix apps/discord-bot build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps/discord-bot/package.json ./apps/discord-bot/
COPY --from=builder /app/apps/discord-bot/dist ./apps/discord-bot/dist
COPY --from=builder /app/node_modules ./node_modules

WORKDIR /app/apps/discord-bot

CMD ["node", "dist/index.js"]
