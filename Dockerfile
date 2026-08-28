# syntax=docker/dockerfile:1

# Sales Boost Bot production image.
# Secrets are intentionally not accepted as build arguments: frontend and backend
# are built using source code only, while credentials are injected at runtime.
FROM node:20-slim AS builder

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL dependencies (including dev for tsc)
COPY package.json package-lock.json ./
COPY apps/vox-smoke-test-server/package.json ./apps/vox-smoke-test-server/package.json
COPY packages/voximplant-smoke/package.json ./packages/voximplant-smoke/package.json
RUN npm ci --ignore-scripts

# Prisma
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript + admin frontend
COPY tsconfig.json ./
COPY src ./src/
COPY public ./public/
COPY data ./data/
COPY admin-frontend ./admin-frontend/
RUN npm run build

# Reuse the exact dependency tree that produced the build, then remove build-only
# packages. This avoids a second network install and keeps the runtime reproducible.
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-slim AS production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production manifest and already-pruned runtime dependencies.
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY --from=builder /app/node_modules ./node_modules

# Copy built output from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/salesboost-entrypoint

# The application runs without root privileges. /data is the persistent SQLite
# mount; /app/tmp is used for short-lived Telegram voice downloads.
RUN mkdir -p /data /app/tmp && chown -R node:node /app /data

ENV NODE_ENV=production
EXPOSE 3000

USER node

ENTRYPOINT ["salesboost-entrypoint"]
CMD ["node", "dist/src/index.js"]
