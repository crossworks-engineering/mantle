#!/usr/bin/env bash
# Preflight before `pnpm dev` — refuse to start with a clear, actionable error
# when the dev infra isn't ready. Without this, a missing Postgres turns into a
# cryptic `ECONNREFUSED 127.0.0.1:54323` Next.js stack trace 30s into boot, which
# is the #1 stumble for a new user (and for anyone who Ctrl-C'd `pnpm start`
# before it finished).
#
# Exits 0 silently when everything's ready; non-zero with a friendly message
# otherwise. Wired into the root `dev` script.

set -euo pipefail

# ── 1. Docker daemon -------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  cat >&2 <<'EOF'

  ✗ Docker isn't running.

    Start Docker Desktop (or your engine), then re-run.
    macOS:  open -a Docker

EOF
  exit 1
fi

# ── 2. Postgres container up + healthy -------------------------------------
if ! docker ps --filter "name=mantle_pg" --filter "health=healthy" --format '{{.Names}}' \
     | grep -q '^mantle_pg$'; then
  cat >&2 <<'EOF'

  ✗ Dev infra isn't running (or postgres isn't healthy yet).

    First-time setup, or after a wipe:
      pnpm start     ← brings up infra + migrations + pg-boss + dev servers
                   (NOT `pnpm up` — that's pnpm's built-in `update` alias)

    Already set up, infra just stopped:
      pnpm infra:up  ← bring infra back up, then `pnpm dev`

    Stuck and want to start fresh:
      pnpm reset     ← wipe the dev brain + rebuild from scratch (asks first)

EOF
  exit 1
fi

# ── 3. Postgres actually accepting connections -----------------------------
if ! docker exec mantle_pg pg_isready -U postgres -d postgres -q 2>/dev/null; then
  cat >&2 <<'EOF'

  ✗ Postgres is running but not accepting connections yet.

    Wait ~10s and re-run `pnpm dev`. If it persists, try `pnpm infra:logs`.

EOF
  exit 1
fi

# ── 4. pg-boss schema present (the racy first-boot trap) -------------------
if ! docker exec mantle_pg psql -U postgres -d postgres -tA -c \
     "select 1 from information_schema.schemata where schema_name='pgboss'" \
     2>/dev/null | grep -q '^1$'; then
  cat >&2 <<'EOF'

  ✗ The pg-boss schema isn't created yet.

    The workers will race to create it on a fresh DB and lose. Run:
      pnpm -C apps/web pgboss:init    ← then `pnpm dev`

    Or just `pnpm start`, which does this for you.

EOF
  exit 1
fi

# All good — silent success so it doesn't clutter the dev output.
