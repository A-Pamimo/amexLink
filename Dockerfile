# syntax=docker/dockerfile:1.7
# Multi-stage build for AmexLens. Produces a small image that runs as a
# non-root user with read-only root filesystem and a writable volume for the
# sqlite db.

ARG NODE_VERSION=20.18.0

# ---------- deps ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# Build deps for better-sqlite3 (native module).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------- build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# Drop unnecessary binaries; install only what we actually need at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DB_PATH=/data/amexlens.sqlite

# Production-only deps. Keeping a separate install avoids carrying build tooling.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 && npm cache clean --force

# Build artifacts.
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/lib/db/migrations ./lib/db/migrations

# Non-root.
RUN groupadd --system --gid 1001 amex \
 && useradd --system --uid 1001 --gid amex --home-dir /app --shell /usr/sbin/nologin amex \
 && mkdir -p /data \
 && chown -R amex:amex /data /app
USER amex

# Healthcheck hits the always-public /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["npx","next","start","-H","0.0.0.0","-p","3000"]
