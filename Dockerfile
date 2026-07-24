# TWO Mantle images from one file (v0.200.0 split):
#
#   --target server → mantle-server: every backend service — API/web host,
#     DBOS runner, the workers, one-shot migrate — same image, different
#     compose `command:` per service (docker-compose.yml).
#   --target client → mantle-client: the ZERO-SECRET owner UI (client/web),
#     one Next server, no DB/no secrets (docker-compose.client.yml).
#
# Build:  docker build --target server -t <ns>/mantle-server:<tag> .
#         docker build --target client -t <ns>/mantle-client:<tag> .
# One MANTLE_IMAGE_TAG drives both composes — releases are lockstep.
#
# Note: server/mcp is intentionally NOT run here. The MCP server is stdio-only
# (StdioServerTransport) — a detached daemon would hit EOF on stdin and
# crash-loop. It runs as a subprocess of whatever launches it (Claude Desktop)
# until the HTTP transport lands. See docs/architecture.md §16.
#
# We keep dev deps (tsx, next, typescript) in the image so the agent + workers
# run TypeScript directly via tsx in production. At personal scale the image-size
# cost is fine; the operational simplicity is worth more.

# ── 1. deps: full workspace install ─────────────────────────────────────────
# Node 24 LTS — long support window (25 is the short-lived "current" line).
# pnpm 11.1.2 (pinned in packageManager) imports a Node builtin not present in
# Node 20, so node:20-slim fails install with ERR_UNKNOWN_BUILTIN_MODULE; 24 is
# safely above that. corepack is unbundled from Node 25+, so we install pnpm via
# npm directly (works on 24 and forward).
FROM node:24-slim AS deps
WORKDIR /app

# Copy manifests first so the install layer is cached when only source changes.
# This list MUST contain every workspace package.json (server/* + client/* + packages/*) or
# `pnpm install --frozen-lockfile` below fails ("missing"/"lockfile mismatch")
# because the workspace it sees doesn't match the lockfile. Keep it in sync when
# adding a package — verify with:
#   diff <(grep -oE '(server|client|packages)/[a-z-]+/package.json|e2e/package.json' Dockerfile | sort -u) \
#        <(find server client packages e2e -maxdepth 2 -name package.json -not -path '*/node_modules/*' | sort -u)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/api/package.json server/api/package.json
COPY server/mcp/package.json server/mcp/package.json
COPY server/web/package.json server/web/package.json
COPY client/web/package.json client/web/package.json
COPY e2e/package.json e2e/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/api-keys/package.json packages/api-keys/package.json
COPY packages/app-build/package.json packages/app-build/package.json
COPY packages/assistant-runtime/package.json packages/assistant-runtime/package.json
COPY packages/calendar/package.json packages/calendar/package.json
COPY packages/client-types/package.json packages/client-types/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/heartbeats/package.json packages/heartbeats/package.json
COPY packages/mcp-core/package.json packages/mcp-core/package.json
COPY packages/microsoft/package.json packages/microsoft/package.json
COPY packages/rules/package.json packages/rules/package.json
COPY packages/runs/package.json packages/runs/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/tabledb/package.json packages/tabledb/package.json
COPY packages/telegram/package.json packages/telegram/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/tracing/package.json packages/tracing/package.json
COPY packages/turn-stream/package.json packages/turn-stream/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/web-ui/package.json packages/web-ui/package.json

# Install the build toolchain (python3 / build-essential, needed to COMPILE
# native modules), pnpm, and the workspace — then PURGE the toolchain in the
# SAME layer so its ~340MB doesn't ship in the image. The compiled `.node`
# artifacts stay in node_modules; only the compiler is removed. ca-certificates
# is kept (runtime HTTPS). Caches are cleaned to keep the layer lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && npm install -g pnpm@11.1.2 \
    && pnpm install --frozen-lockfile \
    && apt-get purge -y python3 build-essential && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.local/share/pnpm/store /root/.cache

# Now copy sources.
COPY . .

# ── 2. server: backend runtime image — workspace + the server Next build ─────
# Carries source + node_modules + the compiled .next, so the SAME image can run
# `next start` (web), the agent, the tsx workers, and the migrator — selected by
# the compose `command:` per service. Defaults to the web server.
FROM deps AS server
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# pg_dump for the scheduled-backup feature (/settings/backups). Must be the
# pgdg v17 client — bookworm's default postgresql-client is 15, and pg_dump
# refuses servers newer than itself. curl is installed and purged in the same
# layer; the pgdg keyring + client stay.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
# NOTE: no browser in this image. The Pages → PDF export drives the `browser`
# compose sidecar (browserless/chromium) over websocket via puppeteer-core —
# see server/web/lib/render-pdf.ts and the compose service definition.
# Build identity — surfaced next to the wordmark + at /api/version. `.git` is
# excluded from the build context (.dockerignore), so next.config.ts can't read
# the SHA inside the image; the build script (scripts/docker-build-push.sh)
# passes it in. Empty defaults keep a bare `docker build .` working.
ARG MANTLE_GIT_SHA=""
ARG MANTLE_BUILD_TIME=""
ENV MANTLE_GIT_SHA=$MANTLE_GIT_SHA
ENV MANTLE_BUILD_TIME=$MANTLE_BUILD_TIME
# `.next/cache` is the build cache (~1.1GB) — `next start` never reads it, so
# drop it: it's the layer that changes every build, so this also keeps
# incremental re-pulls small (the runtime .next is only ~50MB).
RUN pnpm -C server/web build && rm -rf server/web/.next/cache
# Release-owned deploy files, embedded so (a) the updater sidecar can extract
# the CANONICAL docker-compose.yml for this exact release from the already-
# pulled image (in-band — no extra network fetch) and refresh a pristine box
# copy, and (b) the web app can fingerprint the canonical to flag compose
# drift on /settings/updates. Kept AFTER the build layer: compose edits must
# not invalidate the (expensive) next-build cache. See infra/updater/updater.sh
# (compose refresh) + docs/deploy.md.
COPY docker-compose.yml /app/release/docker-compose.yml
COPY docker-compose.client.yml /app/release/docker-compose.client.yml
COPY infra/caddy/Caddyfile /app/release/Caddyfile
COPY infra/updater/updater.sh /app/release/updater.sh
EXPOSE 3000
CMD ["pnpm", "-C", "server/web", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]

# ── 3. client: the zero-secret owner-UI image ────────────────────────────────
# Same deps layer (one lockfile, shared cache); only client/web is built. No
# DB, no SESSION_SECRET — runtime config is compose env (MANTLE_SERVER_ORIGIN)
# read per-request by /env.js. Small public surface: `next start` only.
FROM deps AS client
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG MANTLE_GIT_SHA=""
ARG MANTLE_BUILD_TIME=""
ENV MANTLE_GIT_SHA=$MANTLE_GIT_SHA
ENV MANTLE_BUILD_TIME=$MANTLE_BUILD_TIME
RUN pnpm -C client/web build && rm -rf client/web/.next/cache
EXPOSE 3000
CMD ["pnpm", "-C", "client/web", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
