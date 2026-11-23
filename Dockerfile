# syntax=docker/dockerfile:1.7
# AmexLens production image for Fly.io (docs/deploy/fly.md).
#
# Stages: deps (full install, native toolchain) -> build (next build) -> runtime.
# The runtime stage starts as root only so the entrypoint can chown the Fly
# volume, then drops to uid 1001 (amex) with setpriv, under tini.
# Docker was not available when this file was written; the first `fly deploy`
# is the build proof.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim

# ---------- deps: full install (dev deps are needed by `next build`) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 normally downloads a prebuilt binary; keep the toolchain for the
# fallback source build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Dummy Plaid values satisfy lib/env.ts during `next build` (same as CI). They are
# not baked into the runtime image: the runtime stage copies only build output.
# Security headers are baked here; HSTS (ENABLE_HSTS) and the nonce CSP are applied
# at runtime by middleware.
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAID_CLIENT_ID=build-dummy \
    PLAID_SECRET=build-dummy \
    PLAID_ENV=sandbox
# The repo has no public/ directory; make sure the COPY below never fails on it.
RUN mkdir -p public && npm run build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# tini: PID 1 signal forwarding and zombie reaping. util-linux: setpriv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 amex \
 && useradd --system --uid 1001 --gid amex --home-dir /app --shell /usr/sbin/nologin amex \
 && mkdir -p /data

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DB_PATH=/data/amexlens.sqlite

# Production dependencies only: reuse the compiled node_modules from deps, then prune dev packages.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

# Build output and the files the server reads at runtime:
#  - next.config.mjs imports lib/security-headers.mjs (+ .d.mts for types)
#  - lib/db/migrations is resolved from process.cwd() (lib/db/sqlite/index.ts)
#  - scripts/** holds sync, backup, restore-check, verify-no-plaintext and the entrypoint
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/lib/security-headers.mjs /app/lib/security-headers.d.mts ./lib/
COPY --from=build /app/lib/db/migrations ./lib/db/migrations
COPY --from=build /app/scripts ./scripts

# The app tree stays root-owned and read-only to the app user; only .next/cache and the volume are writable.
RUN chmod 0755 /app/scripts/docker-entrypoint.sh \
 && mkdir -p /app/.next/cache \
 && chown -R amex:amex /app/.next/cache /data

# Fly mounts the volume at /data (root-owned); the entrypoint fixes ownership, then drops privileges.
VOLUME ["/data"]
EXPOSE 3000
# No USER directive on purpose: the entrypoint must chown the root-owned volume, then it
# execs the server as uid 1001 via setpriv. Same reason for DS-0002 in .trivyignore.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
