#!/usr/bin/env bash
# Restore a Mantle dump (from scripts/db-dump.sh) into a freshly-initialized
# Postgres: the standard way to MOVE the brain to a new machine, and the way
# back from a roll (the updater's pre-roll dumps).
#
# IMPORTANT: run this BEFORE the app/migrate services start:
#   1. docker compose pull
#   2. docker compose up -d postgres --wait
#   3. scripts/db-restore.sh backups/mantle-<ts>.dump
#   4. docker compose up -d --wait               # migrate is now a no-op; app starts
#
# Members' personal-space file bytes come back in the same step: when a
# mantle-spaces-<ts>.tgz with the dump's timestamp sits next to the dump (both
# db-dump.sh and the scheduled backup write one), it is untarred into
# ${MANTLE_DATA_DIR:-./data}/spaces, only if that folder is still empty.
# MANTLE_SPACES_ARCHIVE=<path> names another archive.
#
# The dump goes into a PRISTINE database: the script drops the init-made
# `postgres` database and creates an empty one first. The init scripts
# pre-create `auth.users`; when a box's init script is older than the dumped
# table (0181 added session_epoch), pg_restore skipped "CREATE TABLE
# auth.users" (already exists), its COPY then failed, and the restore ended
# "complete" with NO logins and no role CHECK (docs/postgres-18-upgrade.md).
# So the script refuses a target that holds any item or any login, and after
# the restore it checks the logins, the role CHECK and the viewer policies,
# and exits non-zero when one is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP="${1:?usage: scripts/db-restore.sh <path-to.dump>}"
# Same container autodetect as db-dump.sh: dev machines run `mantle_dev_pg`,
# deployed boxes run `mantle_pg`. Explicit MANTLE_PG_CONTAINER wins; refuse to
# guess when both are running (restoring into the wrong brain is the one
# mistake this script must never make).
pick_pg() {
  running() { docker ps --filter "name=$1" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
  if running mantle_pg && running mantle_dev_pg; then
    echo "✗ both mantle_pg and mantle_dev_pg are running — set MANTLE_PG_CONTAINER to pick one." >&2
    return 1
  fi
  if running mantle_dev_pg; then echo mantle_dev_pg; else echo mantle_pg; fi
}
CONTAINER="${MANTLE_PG_CONTAINER:-$(pick_pg)}"
[ -f "$DUMP" ] || { echo "✗ no such dump: $DUMP" >&2; exit 1; }

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "✗ postgres container '$CONTAINER' not reachable — run 'docker compose up -d postgres --wait' first." >&2
  exit 1
fi

# Guard: refuse to restore over a populated brain (run before the app exists).
# The restore drops this database, so a login counts as data too.
EXISTING=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tA -c \
  "SELECT (to_regclass('public.nodes') IS NOT NULL AND (SELECT count(*) FROM nodes) > 0)
       OR (to_regclass('auth.users') IS NOT NULL AND (SELECT count(*) FROM auth.users) > 0)" \
  2>/dev/null || echo "f")
if [ "$EXISTING" = "t" ]; then
  echo "✗ target already has items (public.nodes) or logins (auth.users): refusing to restore over a live brain." >&2
  echo "  Restore into a fresh DB, or drop it deliberately first." >&2
  exit 1
fi

# The viewer roles (member logins Phase 0b, plus the personal-space role of
# Phase 2) are cluster objects: a dump does not carry them, but its row
# policies and grants name them. Create them first (no login; migrate sets the
# login and a password derived from MANTLE_MASTER_KEY), or every policy fails
# to restore: a team-level agent sees an empty brain and a member an empty
# space.
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "
DO \$\$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT', r);
    END IF;
  END LOOP;
END \$\$;"

# A pristine database: nothing from the init scripts for pg_restore to trip
# over. The dump carries the extensions, the auth schema and every table.
echo "▶ Replacing the empty 'postgres' database in '$CONTAINER' with a pristine one"
docker exec "$CONTAINER" psql -U postgres -d template1 -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS postgres WITH (FORCE);" \
  -c "CREATE DATABASE postgres;"

echo "▶ Restoring $DUMP → '$CONTAINER'"
# pg_restore goes on past an error and exits non-zero at the end. Into a
# pristine database there should be none: every one is printed, and the
# checks below decide whether the restore is usable.
RESTORE_LOG="$(mktemp)"
trap 'rm -f "$RESTORE_LOG"' EXIT
RESTORE_RC=0
docker exec -i "$CONTAINER" pg_restore -U postgres -d postgres --no-owner < "$DUMP" \
  > "$RESTORE_LOG" 2>&1 || RESTORE_RC=$?
RESTORE_ERRORS=$(grep -c '^pg_restore: error:' "$RESTORE_LOG" || true)
if [ "$RESTORE_RC" -ne 0 ] || [ "$RESTORE_ERRORS" -gt 0 ]; then
  echo "⚠ pg_restore exited $RESTORE_RC with $RESTORE_ERRORS error(s):" >&2
  grep -E '^pg_restore: (error|warning):|^(Command was|DETAIL|HINT):' "$RESTORE_LOG" | head -40 >&2 || true
fi

q() { docker exec "$CONTAINER" psql -U postgres -d postgres -tA -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }

# What the restored brain must hold. A check applies once the dump's own
# migration ledger shows the migration that made the object, so a pre-roll
# dump from an older release is judged by what that release had. The
# numbers are journal `when` values (packages/db/migrations/meta/_journal.json;
# server/web/lib/db-restore-script.test.ts keeps them in step).
WHEN_0159=1789843200000   # 0159_viewer_access: nodes_viewer_read
WHEN_0162=1790016000000   # 0162_member_logins: users_role_ck
WHEN_0187=1790017500000   # 0187_client_level: agents and tool_groups rules
FAILED=""
fail() { FAILED="${FAILED}  - $1"$'\n'; }

LEDGER=$(q "SELECT coalesce(max(created_at), 0) FROM drizzle.__drizzle_migrations" || echo "")
N=$(q "SELECT count(*) FROM public.nodes" || echo "")
USERS=$(q "SELECT count(*) FROM auth.users" || echo "")
[ -n "$LEDGER" ] || { fail "no migration ledger (drizzle.__drizzle_migrations): is this a Mantle dump?"; LEDGER=0; }
[ -n "$N" ] || fail "public.nodes is missing"
if [ -z "$USERS" ]; then
  fail "auth.users is missing"
elif [ "$USERS" -eq 0 ]; then
  fail "auth.users has no rows: every login is gone (nobody can sign in; first signup may reopen)"
fi
has_constraint() { [ "$(q "SELECT count(*) FROM pg_constraint WHERE conname = '$1' AND conrelid = to_regclass('$2')" || echo 0)" = "1" ]; }
has_policy() { [ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '$2' AND policyname = '$1'" || echo 0)" = "1" ]; }
if [ "$LEDGER" -ge "$WHEN_0162" ] && ! has_constraint users_role_ck auth.users; then
  fail "the login role CHECK (users_role_ck on auth.users) is missing"
fi
REQUIRED_POLICIES=""
[ "$LEDGER" -ge "$WHEN_0159" ] && REQUIRED_POLICIES="nodes_viewer_read:nodes"
[ "$LEDGER" -ge "$WHEN_0187" ] && REQUIRED_POLICIES="$REQUIRED_POLICIES agents_viewer_read:agents agents_client_read:agents tool_groups_viewer_read:tool_groups tool_groups_client_read:tool_groups"
for pt in $REQUIRED_POLICIES; do
  has_policy "${pt%%:*}" "${pt#*:}" || fail "the row policy ${pt%%:*} on ${pt#*:} is missing"
done

if [ -n "$FAILED" ]; then
  echo "✗ Restore FAILED: the database is not a usable brain." >&2
  printf '%s' "$FAILED" >&2
  echo "  Row policies name the viewer roles: a missing one reads as an empty brain to" >&2
  echo "  team and client logins (migrations 0159, 0187). Do not start the app on this" >&2
  echo "  database. Read any pg_restore errors above, fix the cause, and run this again" >&2
  echo "  (drop the database first: the script refuses a target that holds logins)." >&2
  exit 2
fi
if [ "$RESTORE_ERRORS" -gt 0 ] || [ "$RESTORE_RC" -ne 0 ]; then
  echo "✔ Restore complete, WITH $RESTORE_ERRORS pg_restore error(s) listed above: read them. public.nodes has $N rows, auth.users $USERS."
else
  echo "✔ Restore complete: public.nodes has $N rows, auth.users $USERS."
fi

# Personal-space file bytes (member logins). The rows restored above point at
# them; without them every member file answers "gone".
DATA_DIR="${MANTLE_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f .env ]; then
  DATA_DIR="$(sed -n 's/^MANTLE_DATA_DIR=//p' .env | tail -1 | tr -d "\"'")"
fi
DATA_DIR="${DATA_DIR:-./data}"
STAMP="$(basename "$DUMP" .dump)"
STAMP="${STAMP#mantle-}"
SPACES_TGZ="${MANTLE_SPACES_ARCHIVE:-$(dirname "$DUMP")/mantle-spaces-${STAMP}.tgz}"
SPACES_DIR="$DATA_DIR/spaces"
if [ ! -f "$SPACES_TGZ" ]; then
  echo "▷ no personal-space archive at $SPACES_TGZ — member files not restored (none backed up, or pass MANTLE_SPACES_ARCHIVE=<tgz>)."
elif [ -d "$SPACES_DIR" ] && [ -n "$(ls -A "$SPACES_DIR" 2>/dev/null | grep -vx '.upload-spool')" ]; then
  echo "⚠ $SPACES_DIR is not empty — member files NOT restored. Untar $SPACES_TGZ there by hand if you mean it." >&2
else
  mkdir -p "$SPACES_DIR"
  tar -C "$SPACES_DIR" -xzf "$SPACES_TGZ"
  echo "✔ Restored personal-space files → $SPACES_DIR"
fi

echo "  Next:  docker compose up -d --wait    (migrate will be a no-op)"
echo "  Don't forget the file bytes:  rsync your \$MANTLE_DATA_DIR/{files,rustfs} across too."
echo "  Table workbooks: untar mantle-table-dbs-<ts>.tgz into \$MANTLE_DATA_DIR/table-dbs;"
echo "  app databases: scripts/app-dbs-restore.sh after the stack is up."
