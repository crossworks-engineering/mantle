# Single Mantle image. Every runtime service — web, agent, the four workers,
# and the one-shot migrate — is the SAME image; they differ only in the command
# the compose file runs (web → `next start`, agent → its entry, workers → their
# tsx scripts, migrate → the migrator). One artifact to build, version, push,
# and pull instead of seven near-identical ones.
#
# Build:   docker build -t <namespace>/mantle:<tag> .
# Or use docker-compose.yml, which runs every service from this one image.
#
# Note: apps/mcp is intentionally NOT run here. The MCP server is stdio-only
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
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-keys/package.json packages/api-keys/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/rules/package.json packages/rules/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/telegram/package.json packages/telegram/package.json
COPY packages/tracing/package.json packages/tracing/package.json

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

# ── 2. app: the one runtime image — workspace + the Next production build ─────
# Carries source + node_modules + the compiled .next, so the SAME image can run
# `next start` (web), the agent, the tsx workers, and the migrator — selected by
# the compose `command:` per service. Defaults to the web server.
FROM deps AS app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# `.next/cache` is the build cache (~1.1GB) — `next start` never reads it, so
# drop it: it's the layer that changes every build, so this also keeps
# incremental re-pulls small (the runtime .next is only ~50MB).
RUN pnpm -C apps/web build && rm -rf apps/web/.next/cache
EXPOSE 3000
CMD ["pnpm", "-C", "apps/web", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
