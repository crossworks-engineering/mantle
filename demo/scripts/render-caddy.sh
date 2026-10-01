#!/usr/bin/env bash
# Render the demo's Caddy vhost and install it on the site box.
#
#   demo/scripts/render-caddy.sh              render → install → reload
#   demo/scripts/render-caddy.sh --print      render to stdout, install nothing
#   DEMO_HOST=cwe@other.box demo/scripts/render-caddy.sh
#
# The rendered file injects MINTED SESSION COOKIES into every upstream request,
# which makes it a secret. That is the entire reason it is not a committed vhost
# in the mantle-site repo (public) and instead lands in that box's conf.d, which
# the site's deploy creates but never writes to and never deletes.
#
# The site's Caddyfile picks it up with `import /etc/caddy/conf.d/*.caddy`. A
# glob matching nothing is valid Caddy, so a box without this file still serves
# the site normally — which is why the import can be committed even though its
# contents cannot.
#
# Re-run this whenever the cookies need reminting (a rotated SESSION_SECRET, a
# re-seeded brain, a new team member). Nothing else has to change: the site
# repo holds no demo state at all.
#
# One thing crosses from the bench to the box besides the vhost: the phone-app
# bearer is minted as a mobile_tokens row in the BENCH brain, and the box's
# brain, restored from a bundle dumped earlier, has never seen it. The edge
# would hand reviewers a bearer the server rejects. So after minting, this
# script copies the mobile_tokens rows into the box's database (INSERT … ON
# CONFLICT DO NOTHING, so a re-run is harmless) and checks the new jti is
# there before it installs the vhost. DEMO_REMOTE_PG names the box's postgres
# container (default mantle_demo_srv_pg, the serve stack's).
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"; mkdir -p "$ART"

HOST="${DEMO_HOST:-cwe@mantle-ai.tech}"
REMOTE_DIR="${DEMO_REMOTE_DIR:-mantle-site}"
PRINT_ONLY=0
[ "${1:-}" = "--print" ] && PRINT_ONLY=1

# Upstreams are the SERVE stack's container names, reachable because the site's
# Caddy joins mantle_demo_net. Container names, not service names: unambiguous
# on a network two compose projects share.
UPSTREAM_UI="${DEMO_UPSTREAM_UI:-mantle_demo_srv_client:3000}"
UPSTREAM_API="${DEMO_UPSTREAM_API:-mantle_demo_srv_web:3000}"

# The seed stack's owner connection: minting reads auth.users and writes the
# phone-app token row, and the reader role can do neither.
export DATABASE_URL="${DEMO_OWNER_URL:-postgres://postgres:postgres@127.0.0.1:56432/postgres}"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"

fail() { echo "✗ $1" >&2; exit 1; }

docker inspect -f '{{.State.Running}}' mantle_demo_pg 2>/dev/null | grep -q true \
  || fail "mantle_demo_pg is not running — the cookies are minted against the seed brain (demo/scripts/stack-up.sh)"

# SESSION_SECRET here must match what the SERVE box runs with, or the cookie is
# a valid HMAC over the wrong key and every visitor lands on a login screen with
# nothing in any log to say why.
echo "→ minting" >&2
SESSION=$(pnpm -s -C server/web exec tsx ../../demo/seed/mint-session.ts | tail -1)
[ -n "$SESSION" ] || fail "failed to mint the owner session"
echo "  session (${#SESSION} chars, never printed)" >&2

# The phone app's credential. The edge answers POST /api/auth/mobile-login
# itself with this bearer (a real mobile_tokens row for the demo owner), so
# store reviewers can sign in with any username and password. Until now this
# was substituted by hand on the box and the rendered vhost drifted from
# Caddyfile.demo — re-running this script would have silently dropped it.
MOBILE_TOKEN=$(pnpm -s -C server/web exec tsx ../../demo/seed/mint-mobile-token.ts | tail -1)
[ -n "$MOBILE_TOKEN" ] || fail "failed to mint the phone-app bearer"
echo "  mobile token (${#MOBILE_TOKEN} chars, never printed)" >&2

RENDERED="$ART/demo.caddy"
sed -e "s|__DEMO_SESSION__|$SESSION|" \
    -e "s|__DEMO_MOBILE_TOKEN__|$MOBILE_TOKEN|" \
    -e "s|__DEMO_WEB__|$UPSTREAM_UI|" \
    -e "s|__DEMO_API__|$UPSTREAM_API|" \
    "$DEMO/deploy/Caddyfile.demo" > "$RENDERED"
chmod 600 "$RENDERED"
grep -q '__DEMO_' "$RENDERED" && fail "a placeholder survived rendering — check Caddyfile.demo"

if [ "$PRINT_ONLY" = "1" ]; then
  cat "$RENDERED"
  echo "(not installed — --print)" >&2
  exit 0
fi

# The bearer's jti is inside its payload (base64url JSON, first segment). It
# is what the box has to hold for the token to be honoured, and it is how the
# carry below is verified rather than assumed.
JTI=$(printf '%s' "${MOBILE_TOKEN%%.*}" | tr '_-' '/+' \
  | awk '{ l = length($0) % 4; if (l == 2) $0 = $0 "=="; else if (l == 3) $0 = $0 "="; print }' \
  | base64 -d 2>/dev/null | sed -n 's/.*"jti":"\([^"]*\)".*/\1/p')
[ -n "$JTI" ] || fail "could not read the jti out of the minted bearer"

REMOTE_PG="${DEMO_REMOTE_PG:-mantle_demo_srv_pg}"
echo "→ carrying mobile_tokens to $HOST ($REMOTE_PG)" >&2
# --inserts + --on-conflict-do-nothing: rows the box already has (an earlier
# run, or the bundle itself) are skipped instead of failing the load. Only this
# table travels; nothing else on the box's brain is touched.
docker exec mantle_demo_pg pg_dump -U postgres -d postgres --data-only --inserts \
    --on-conflict-do-nothing -t mobile_tokens \
  | ssh "$HOST" "docker exec -i $REMOTE_PG psql -U postgres -d postgres -q -v ON_ERROR_STOP=1" \
  || fail "carrying mobile_tokens to the box failed — the phone-app bearer would be refused there; NOT installing"
FOUND=$(ssh "$HOST" "docker exec $REMOTE_PG psql -U postgres -d postgres -Atc \"select count(*) from mobile_tokens where id = '$JTI'\"")
[ "$FOUND" = "1" ] || fail "the minted bearer's row ($JTI) is not on the box after the carry — NOT installing"
echo "  row $JTI present on the box" >&2

echo "→ installing on $HOST" >&2
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/conf.d && chmod 700 ~/$REMOTE_DIR/conf.d"
# --inplace: the site's conf.d is a bind-mounted DIRECTORY so a new inode is
# fine here, but keeping the same write semantics as the Caddyfile costs
# nothing and avoids a surprise if this ever becomes a single-file mount.
scp -q "$RENDERED" "$HOST:~/$REMOTE_DIR/conf.d/demo.caddy"
ssh "$HOST" "chmod 600 ~/$REMOTE_DIR/conf.d/demo.caddy"

echo "→ validating the FULL site config with this file in it" >&2
ssh "$HOST" "docker exec mantle-site-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null 2>&1 \
  || fail "the site config does not validate with this vhost — NOT reloading (the site is untouched)"
echo "  valid" >&2

echo "→ reloading" >&2
ssh "$HOST" "docker exec -w /etc/caddy mantle-site-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null 2>&1 \
  || fail "reload failed — Caddy keeps serving the previous config"

echo >&2
echo "✓ demo vhost installed and live." >&2
echo "  Verify, in this order — the SITE first, because it shares this Caddy:" >&2
echo "    curl -so /dev/null -w '%{http_code}\\n' https://mantle-ai.tech" >&2
echo "    curl -so /dev/null -w '%{http_code}\\n' https://demo.mantle-ai.tech" >&2
echo "    demo/scripts/check-readonly.sh https://demo.mantle-ai.tech" >&2
echo "    demo/scripts/check-routes.sh   https://demo.mantle-ai.tech" >&2
