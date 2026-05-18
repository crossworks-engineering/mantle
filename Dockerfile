# Multi-stage Dockerfile producing four runtime targets — web, agent,
# worker-email, worker-telegram — all sharing one workspace install. Build
# any single image with:
#   docker build --target web -t mantle/web .
#
# Or use docker-compose.yml, which wires all four behind postgres+minio.
#
# We install dev deps too (tsx, next, typescript) so the agent + workers can
# keep running TypeScript directly via tsx in production. At personal scale
# the image-size cost is fine; the operational simplicity is worth more.

# ── 1. deps: full workspace install ─────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

# Tooling for native modules (postgres-js / pg-boss / sharp / esbuild /
# unrs-resolver). Drop these once everything builds on prebuilt binaries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# Copy manifests first so we get a cached install layer when only source changes.
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

RUN pnpm install --frozen-lockfile

# Now copy sources.
COPY . .

# ── 2. build-web: produce the Next.js production bundle ─────────────────────
FROM deps AS build-web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm -C apps/web build

# ── 3. web runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS web
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# Bring over the entire workspace including the .next build directory.
# Simpler than wrestling with Next standalone output + workspace package
# resolution.
COPY --from=build-web /app /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["pnpm", "-C", "apps/web", "start", "--", "-H", "0.0.0.0", "-p", "3000"]

# ── 4. agent runtime ────────────────────────────────────────────────────────
FROM deps AS agent
ENV NODE_ENV=production
CMD ["pnpm", "-C", "apps/agent", "start"]

# ── 5. worker-email runtime ─────────────────────────────────────────────────
FROM deps AS worker-email
ENV NODE_ENV=production
# The worker scripts live in apps/web/workers/ and reuse the web's
# .env.local in dev. In containers we read env from the compose file
# instead — the --env-file-if-exists flag is a no-op when the file is absent.
CMD ["pnpm", "-C", "apps/web", "exec", "tsx", "workers/email-sync.ts"]

# ── 6. worker-telegram runtime ──────────────────────────────────────────────
FROM deps AS worker-telegram
ENV NODE_ENV=production
CMD ["pnpm", "-C", "apps/web", "exec", "tsx", "workers/telegram-poll.ts"]
