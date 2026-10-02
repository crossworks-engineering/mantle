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
# the restore it checks the logins, the role CHECK, the viewer policies and
# every trigger the dump lists, and exits 2 when one is missing. It exits 3,
# after its last step, when pg_restore reported an error it cannot explain:
# the brain passed the checks, but something in the dump did not restore.
#
# The brain id (migration 0226, docs/mobile-companion-backend.md "Push
# routing on a device with several logins"). Phones and desktops tell brains
# apart by it. A plain restore KEEPS the dump's id: this is the same brain
# (its own backup, the way back from a roll, or a move to a new machine that
# replaces the old one). When the restored database is a NEW brain made from
# another brain's dump, one that will run BESIDE the brain the dump came
# from (dev data seeded into a new prod box, one generated dump seeded onto
# several boxes), pass --new-brain: the restored brain gets an id of its own,
# so a device holding logins on both can still tell them apart.
#
#   scripts/db-restore.sh [--new-brain] <path-to.dump>
set -euo pipefail
cd "$(dirname "$0")/.."

NEW_BRAIN=0
DUMP=""
for arg in "$@"; do
  case "$arg" in
    --new-brain) NEW_BRAIN=1 ;;
    -*) echo "✗ unknown option: $arg (usage: scripts/db-restore.sh [--new-brain] <path-to.dump>)" >&2; exit 1 ;;
    *)
      [ -z "$DUMP" ] || { echo "✗ one dump at a time (usage: scripts/db-restore.sh [--new-brain] <path-to.dump>)" >&2; exit 1; }
      DUMP="$arg" ;;
  esac
done
[ -n "$DUMP" ] || { echo "usage: scripts/db-restore.sh [--new-brain] <path-to.dump>" >&2; exit 1; }
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
# pristine database there should be none: every one is printed, the checks
# below decide whether the restore is usable, and an error left unexplained
# makes the script exit 3 at its end.
RESTORE_LOG="$(mktemp)"
KEEP_LOG=""   # set on exit 2 and 3: the full pg_restore output stays to be read
trap '[ -n "$KEEP_LOG" ] || rm -f "$RESTORE_LOG"' EXIT
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
WHEN_0188=1790017560000   # 0188_client_signin_codes: client sign-in links and codes
WHEN_0204=1790018520000   # 0204_folder_sharing: nodes_share_refresh_after, in a form no dump can carry
WHEN_0212=1790019000000   # 0212_restorable_share_refresh_trigger: the same trigger, in a form a dump can carry
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

# Every trigger the dump lists must be in the restored database. pg_restore
# goes on past a CREATE TRIGGER it cannot run, and nothing in the app notices
# a missing trigger: the rule it kept just stops being kept. The dump's table
# of contents names each one as "TRIGGER <schema> <table> <trigger>".
restored_triggers() {
  q "SELECT n.nspname || '.' || c.relname || '.' || t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal"
}
DUMP_TRIGGERS=""
if TOC=$(docker exec -i "$CONTAINER" pg_restore --list < "$DUMP" 2>/dev/null); then
  DUMP_TRIGGERS=$(printf '%s\n' "$TOC" | awk '$4 == "TRIGGER" { print $5 "." $6 "." $7 }' | sort -u)
else
  fail "could not read the dump's table of contents (pg_restore --list): its triggers are not checked"
fi
HAVE_TRIGGERS=$(restored_triggers || echo "")

# One trigger no dump taken before migration 0212 can carry: 0204 made
# nodes_share_refresh_after with IS DISTINCT FROM on the ltree path, which
# pg_restore cannot run ("operator does not exist: public.ltree =
# public.ltree"). Without it a folder share, unshare, move or rename no
# longer reaches the rows below the folder. A brain at 0204 or later must
# have it, whether or not the dump lists it (a dump of a brain that was
# itself restored without it does not). For a dump from before 0212 it is
# made here as 0212 makes it, so a pre-roll dump restores whole under the
# release that took it. A dump of a brain that had already lost the trigger
# can carry stale levels: migration 0212 repairs them at the next migrate,
# and under a release before 0212 the nightly share-drift sweep does.
SHARE_REFRESH=public.nodes.nodes_share_refresh_after
SHARE_REFRESH_TRIGGER=$(cat <<'SQL'
CREATE TRIGGER "nodes_share_refresh_after"
  AFTER UPDATE OF "path", "share_level" ON "public"."nodes"
  FOR EACH ROW
  WHEN (NEW."type" = 'branch'
        AND (OLD."path"::text IS DISTINCT FROM NEW."path"::text
             OR OLD."share_level" IS DISTINCT FROM NEW."share_level"))
  EXECUTE FUNCTION "public"."mantle_nodes_refresh_trg"();
SQL
)
# A whole-line match with no pipe (under pipefail a grep -q that ends early
# can fail the pipe) and no pattern: the name is compared as it is.
has_trigger() {
  case $'\n'"$HAVE_TRIGGERS"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}
EXPLAINED_ERRORS=0
if [ "$LEDGER" -ge "$WHEN_0204" ] && [ "$LEDGER" -lt "$WHEN_0212" ] && ! has_trigger "$SHARE_REFRESH"; then
  if MADE=$(docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
              -c "$SHARE_REFRESH_TRIGGER" 2>&1); then
    echo "▷ The dump is from before migration 0212: it cannot carry the trigger"
    echo "  nodes_share_refresh_after (the ltree error, if one is listed above). Made it, as 0212 does."
    HAVE_TRIGGERS=$(restored_triggers || echo "")
    # The one error such a dump gives is the failed CREATE of this trigger
    # (pg_restore prints the statement after the error): explained, not
    # counted.
    EXPLAINED_ERRORS=$(grep -c '^Command was: CREATE TRIGGER nodes_share_refresh_after ' "$RESTORE_LOG" || true)
    [ "$EXPLAINED_ERRORS" -le 1 ] || EXPLAINED_ERRORS=1
  else
    echo "⚠ could not make the trigger nodes_share_refresh_after:" >&2
    printf '%s\n' "$MADE" | sed 's/^/    /' >&2
  fi
fi
# From 0204 on the trigger must be there, listed by the dump or not.
if [ "$LEDGER" -ge "$WHEN_0204" ] && ! has_trigger "$SHARE_REFRESH"; then
  fail "the trigger nodes_share_refresh_after on public.nodes is missing (folder shares no longer reach the rows below a folder)"
fi
# Read line by line: a name is never split or matched against file names.
while IFS= read -r t; do
  [ -n "$t" ] || continue
  [ "$t" = "$SHARE_REFRESH" ] && continue   # judged above
  has_trigger "$t" || fail "the trigger ${t##*.} on ${t%.*} is missing"
done <<EOF_TRIGGERS
$DUMP_TRIGGERS
EOF_TRIGGERS

if [ -n "$FAILED" ]; then
  echo "✗ Restore FAILED: the database is not a usable brain." >&2
  printf '%s' "$FAILED" >&2
  echo "  Row policies name the viewer roles: a missing one reads as an empty brain to" >&2
  echo "  team and client logins (migrations 0159, 0187). A missing trigger is a rule the" >&2
  echo "  database no longer keeps, with no error anywhere. Do not start the app on this" >&2
  echo "  database. Read any pg_restore errors above, fix the cause, and run this again" >&2
  echo "  (drop the database first: the script refuses a target that holds logins)." >&2
  KEEP_LOG=1
  echo "  The full pg_restore output is kept in $RESTORE_LOG" >&2
  exit 2
fi
# An error pg_restore reported that nothing above explains (or a non-zero
# exit with no error line at all): the checks passed, so the steps below
# still run, but the script ends non-zero and never says "Restore complete".
UNEXPLAINED=$((RESTORE_ERRORS - EXPLAINED_ERRORS))
if [ "$UNEXPLAINED" -eq 0 ] && [ "$RESTORE_ERRORS" -eq 0 ] && [ "$RESTORE_RC" -ne 0 ]; then
  UNEXPLAINED=1
fi
if [ "$UNEXPLAINED" -gt 0 ]; then
  echo "⚠ Restored, but pg_restore reported $UNEXPLAINED error(s) this script cannot explain (listed above)." >&2
  echo "  public.nodes has $N rows, auth.users $USERS. The last steps run now; the script then exits 3." >&2
elif [ "$EXPLAINED_ERRORS" -gt 0 ]; then
  echo "✔ Restore complete: public.nodes has $N rows, auth.users $USERS (the one pg_restore error above is explained and repaired)."
else
  echo "✔ Restore complete: public.nodes has $N rows, auth.users $USERS."
fi

# Client sign-in (client logins audit B22). A dump from before a roll brings
# back sign-in links and emailed codes that were used or revoked after it was
# taken, and each client login's session epoch as it was then, so a session
# an admin ended since works again. Every open link and code is revoked (an
# admin issues new links), and the client logins are listed for review.
if [ "$LEDGER" -ge "$WHEN_0188" ]; then
  REVOKED=$(q "WITH r AS (UPDATE public.client_signin_codes SET revoked_at = now()
                          WHERE used_at IS NULL AND revoked_at IS NULL RETURNING 1)
               SELECT count(*) FROM r" || echo "")
  if [ -z "$REVOKED" ]; then
    echo "⚠ could not revoke the open client sign-in links and codes: run by hand before the app starts:" >&2
    echo "    UPDATE client_signin_codes SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL;" >&2
  else
    echo "▷ Client sign-in: revoked $REVOKED open sign-in link(s) and emailed code(s) from the dump. Issue new links where needed."
  fi
  CLIENTS=$(q "SELECT email || '  (' || CASE WHEN disabled_at IS NULL THEN 'active' ELSE 'disabled' END
                      || ', last sign-in ' || coalesce(to_char(last_login_at, 'YYYY-MM-DD HH24:MI'), 'never') || ')'
               FROM auth.users WHERE role = 'client' ORDER BY email" || echo "")
  if [ -n "$CLIENTS" ]; then
    echo "⚠ Review the client logins below: this dump restores their sessions as they were when it was taken."
    echo "  Any client whose sessions were ended, or who was disabled, after that: End sessions or Disable"
    echo "  again in Team admin > Clients as soon as the app is up."
    printf '%s\n' "$CLIENTS" | sed 's/^/    /'
  fi
fi

# The brain id (migration 0226). A dump from before 0226 has no table: the
# migrate that runs next makes one with a fresh id, whichever way this ran.
HAS_BRAIN_ID=$(q "SELECT to_regclass('public.brain_identity') IS NOT NULL" || echo "")
DUMP_BRAIN_ID=""
[ "$HAS_BRAIN_ID" = "t" ] && DUMP_BRAIN_ID=$(q "SELECT brain_id FROM public.brain_identity" || echo "")
if [ "$NEW_BRAIN" = 1 ]; then
  if [ "$HAS_BRAIN_ID" != "t" ]; then
    echo "▷ New brain: the dump is from before migration 0226 (no brain id); migrate gives this brain its own."
  elif [ -z "$DUMP_BRAIN_ID" ]; then
    echo "▷ New brain: the dump holds no brain id row; the app makes one of its own on first use."
  else
    # A CTE, so psql prints the id and not the command tag after it.
    NEW_ID=$(q "WITH u AS (UPDATE public.brain_identity SET brain_id = gen_random_uuid() RETURNING brain_id)
                SELECT brain_id FROM u" || echo "")
    if [ -z "$NEW_ID" ] || [ "$NEW_ID" = "$DUMP_BRAIN_ID" ]; then
      echo "✗ --new-brain: could not give the restored brain an id of its own. Do not start the app:" >&2
      echo "  it would share the id of the brain the dump came from. Run by hand, then start it:" >&2
      echo "    UPDATE brain_identity SET brain_id = gen_random_uuid();" >&2
      KEEP_LOG=1
      echo "  The full pg_restore output is kept in $RESTORE_LOG" >&2
      exit 2
    fi
    echo "▷ New brain: brain id $NEW_ID (the dump's brain keeps ${DUMP_BRAIN_ID:-its own})."
  fi
elif [ -n "$DUMP_BRAIN_ID" ]; then
  echo "▷ Brain id $DUMP_BRAIN_ID kept: this is the same brain as the dump's (its backup, a roll back, a move)."
  echo "  If this database is a NEW brain that will run beside the dump's, give it its own id before"
  echo "  the app starts (phones would otherwise mix the two up):"
  echo "    UPDATE brain_identity SET brain_id = gen_random_uuid();   (or restore again with --new-brain)"
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

if [ "$UNEXPLAINED" -gt 0 ]; then
  echo "✗ pg_restore reported $UNEXPLAINED error(s) this script cannot explain: something in the dump" >&2
  echo "  did not restore, and nothing in the app will say so. The logins, the role CHECK, the" >&2
  echo "  viewer policies and the triggers are there. Read the errors above and find what is" >&2
  echo "  missing before you start the app (docker compose up -d --wait). The file bytes still" >&2
  echo "  need to come across: \$MANTLE_DATA_DIR/{files,rustfs}, table-dbs, and the app databases." >&2
  KEEP_LOG=1
  echo "  The full pg_restore output is kept in $RESTORE_LOG" >&2
  exit 3
fi
echo "  Next:  docker compose up -d --wait    (migrate will be a no-op)"
echo "  Don't forget the file bytes:  rsync your \$MANTLE_DATA_DIR/{files,rustfs} across too."
echo "  Table workbooks: untar mantle-table-dbs-<ts>.tgz into \$MANTLE_DATA_DIR/table-dbs;"
echo "  app databases: scripts/app-dbs-restore.sh after the stack is up."
