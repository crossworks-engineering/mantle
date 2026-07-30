#!/usr/bin/env bash
# Prove the read-only edge actually holds. Writing it is not the same as it
# working, and "the demo is read-only" is a claim that has to survive a
# hostile poke — a public URL will get one.
#
#   demo/scripts/check-readonly.sh [base-url]     default: http://127.0.0.1:56080
#
# Runs against a Caddy that has the demo block loaded. Exits non-zero on the
# first hole found.
set -uo pipefail
BASE="${1:-http://127.0.0.1:56080}"
fail=0

say()  { printf '%-52s %s\n' "$1" "$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" ${3:+-H "content-type: application/json" -d "$3"} --max-time 15; }

echo "read-only edge check → $BASE"
echo

# ── PAGES must render. This check originally tested only /api/*, so it passed
# green while every actual screen 404'd — the edge was pointed at server/web,
# which has ZERO pages (all 94 live in client/web). A visitor does not fetch
# /api/version; they open a page. Test what a visitor does.
for path in / /pages /tasks /notes /tables /assistant /debug/integrity /settings/agents; do
  c=$(code GET "$path")
  if [ "$c" = "200" ]; then say "GET $path" "200 renders"
  else say "GET $path" "$c  ✗ EXPECTED 200 — is the UI upstream wired?"; fail=1; fi
done
echo

# ── The landing page must contain real content, not an empty shell or a login
# Match a login FORM, not the substring "login" — the nav has a "Logins" item
# (the secrets screen), which made a naive match cry wolf on a working page.
html=$(curl -s --max-time 20 "$BASE/" | tr -d '\0')
if [ -z "$html" ]; then
  say "landing page" "✗ empty body"; fail=1
elif printf '%s' "$html" | grep -qiE 'type="password"|Sign in to|name="password"'; then
  say "landing page" "✗ a LOGIN FORM — cookie injection is not reaching the UI"; fail=1
elif [ "${#html}" -lt 20000 ]; then
  say "landing page" "✗ only ${#html} bytes — looks like an empty shell"; fail=1
else
  say "landing page" "renders (${#html} bytes)"
fi
echo

# ── The BROWSER's data path, which is what actually decides whether a visitor
# sees content or an eternal spinner. Three times in P5 a layer worked in
# isolation while the visitor saw nothing: API with no UI behind it, UI that
# bounced to /login, and finally a UI whose fetches went straight to the API
# and bypassed the cookie-injecting edge. Every one of those returned 200 for
# the page. A 200 with a spinner is the failure this check exists to catch.
envjs=$(curl -s --max-time 20 "$BASE/env.js")
api_base=$(printf '%s' "$envjs" | grep -oE '"apiBase":"[^"]*"' | cut -d'"' -f4)
if [ "$api_base" = "$BASE" ] || [ -z "$api_base" ]; then
  say "browser apiBase" "same origin ($BASE)"
else
  say "browser apiBase" "✗ $api_base — bypasses the edge, so every fetch 401s and the UI spins"
  fail=1
fi

# And that origin must actually return data, not just a 200.
total=$(curl -s --max-time 20 "$BASE/api/dashboard" | grep -oE '"nodesTotal":[0-9]+' | cut -d: -f2)
if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
  say "content behind that origin" "$total nodes"
else
  say "content behind that origin" "✗ no nodes — the UI would render an empty shell"; fail=1
fi
echo

# ── Reads must work, and must be authenticated by the injected cookie ────────
for path in /api/version /api/shell /api/dashboard /api/notes /api/pages /api/tasks; do
  c=$(code GET "$path")
  if [ "$c" = "200" ]; then say "GET $path" "200 ok"
  else say "GET $path" "$c  ✗ EXPECTED 200"; fail=1; fi
done

# A 401 anywhere above means the cookie injection is not reaching the app —
# the demo would show a login screen to the public.
echo

# ── Writes must be refused, on every verb and both route families ────────────
for spec in "POST /api/notes {\"title\":\"pwned\",\"content\":\"x\"}" \
            "POST /api/tasks {\"title\":\"pwned\"}" \
            "POST /api/pages {\"title\":\"pwned\"}" \
            "PATCH /api/profile {\"name\":\"pwned\"}" \
            "DELETE /api/notes -" \
            "PUT /api/notes -" \
            "POST /api/assistant/turn {\"text\":\"hello\"}" \
            "POST /api/auth/logout -"; do
  set -- $spec
  verb="$1"; path="$2"; body="${3:--}"
  [ "$body" = "-" ] && body=""
  c=$(code "$verb" "$path" "$body")
  if [ "$c" = "403" ]; then say "$verb $path" "403 refused"
  else say "$verb $path" "$c  ✗ EXPECTED 403 — WRITE GOT THROUGH"; fail=1; fi
done

echo
# ── The refusal must be honest JSON, not an HTML error page ─────────────────
body=$(curl -s -X POST "$BASE/api/notes" -H 'content-type: application/json' -d '{}' --max-time 15)
case "$body" in
  *read-only*) say "refusal body" "explains itself" ;;
  *)           say "refusal body" "✗ not the read-only message: ${body:0:60}"; fail=1 ;;
esac

echo
if [ "$fail" = 0 ]; then
  echo "✓ read-only edge holds — reads authenticated, every write refused"
else
  echo "✗ read-only edge has holes — see above. NOT publishable."
fi
exit "$fail"
