# syntax=docker/dockerfile:1

# Sales Boost Bot production image.
# Secrets are intentionally not accepted as build arguments: frontend and backend
# are built using source code only, while credentials are injected at runtime.
FROM node:20-slim AS builder

# These identifiers are safe to embed in the browser bundle. The auth token
# used to upload source maps is passed separately as a BuildKit secret.
ARG SENTRY_FRONTEND_DSN=""
ARG SENTRY_ORG=""
ARG SENTRY_FRONTEND_PROJECT=""
ARG SENTRY_RELEASE=""
ARG SENTRY_ENVIRONMENT="production"
ARG SENTRY_TRACES_SAMPLE_RATE="0.1"
ARG SENTRY_UPLOAD_SOURCEMAPS="false"
ENV SENTRY_FRONTEND_DSN=$SENTRY_FRONTEND_DSN \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_FRONTEND_PROJECT=$SENTRY_FRONTEND_PROJECT \
    SENTRY_RELEASE=$SENTRY_RELEASE \
    SENTRY_ENVIRONMENT=$SENTRY_ENVIRONMENT \
    SENTRY_TRACES_SAMPLE_RATE=$SENTRY_TRACES_SAMPLE_RATE \
    SENTRY_UPLOAD_SOURCEMAPS=$SENTRY_UPLOAD_SOURCEMAPS

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
RUN --mount=type=secret,id=sentry_auth_token,required=false \
    if [ -f /run/secrets/sentry_auth_token ]; then export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; fi; \
    npm run build

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
RUN mkdir -p /data /app/tmp /app/storage/recordings && chown -R node:node /app /data

ENV NODE_ENV=production
EXPOSE 3000

USER node

ENTRYPOINT ["salesboost-entrypoint"]
CMD ["node", "--enable-source-maps", "dist/src/index.js"]
