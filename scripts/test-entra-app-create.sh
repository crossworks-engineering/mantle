#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# Behavioural tests for scripts/entra-app-create.sh with a fake `az` on PATH
# (no Azure login, no tenant). The fake records each call and answers from
# small state files. Run by hand:
#
#   bash scripts/test-entra-app-create.sh
#
# What it proves: the calls and their order for a new app, the re-run path
# (reuse, no new secret), --new-secret (always --append), --list, the dry
# run with no az at all, the plain error lines, and that the secret is in no
# file and on no command line.
# shellcheck disable=SC2015 # "test && ok || bad": ok only echoes, so bad runs only on a failed test.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/entra-app-create.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

mkdir -p "$tmp/bin" "$tmp/state" "$tmp/home"
: >"$tmp/state/apps"; : >"$tmp/state/sps"; : >"$tmp/state/grants"; : >"$tmp/state/creds"
cat >"$tmp/bin/az" <<'STUB'
#!/usr/bin/env bash
# Fake az: logs the call, answers from $AZ_STATE. Never writes a secret.
printf '%s\n' "$*" >>"$AZ_LOG"
S=$AZ_STATE
arg() { local f=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$f" ] && { printf '%s' "$2"; return; }; shift; done; }
quoted() { sed -n "s/^[^']*'\([^']*\)'.*/\1/p"; } # the first '...' value in a filter
case "$1 $2 $3" in
  "account show --query")
    [ -f "$S/nologin" ] && { echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; }
    echo 11111111-1111-1111-1111-111111111111 ;;
  "ad app list")
    name=$(arg --filter "$@" | quoted)
    awk -F'\t' -v n="$name" '$1 == n { print $2 }' "$S/apps" ;;
  "ad app create")
    n=$(($(wc -l <"$S/apps") + 1))
    id=$(printf 'aaaaaaaa-0000-0000-0000-%012d' "$n")
    printf '%s\t%s\t%s\n' "$(arg --display-name "$@")" "$id" "$(arg --web-redirect-uris "$@")" >>"$S/apps"
    echo "$id" ;;
  "ad app show")
    id=$(arg --id "$@"); q=$(arg --query "$@")
    case "$q" in
      contains*) r=$(awk -F'\t' -v i="$id" '$2 == i { print $3 }' "$S/apps")
        case "$q" in *"'$r'"*) echo true ;; *) echo false ;; esac ;;
      length*) echo 1 ;;
      signInAudience) echo AzureADMyOrg ;;
    esac ;;
  "ad sp list")
    app=$(arg --filter "$@" | quoted)
    awk -F'\t' -v a="$app" '$1 == a { print $2 }' "$S/sps" ;;
  "ad sp create")
    app=$(arg --id "$@"); printf '%s\tsp-%s\n' "$app" "$app" >>"$S/sps"; echo "sp-$app" ;;
  "ad sp update") ;;
  "ad sp show") echo graph-sp ;;
  "ad app permission")
    case "$4" in
      list-grants) sp=$(arg --filter "$@" | quoted); { grep -c "^$sp\$" "$S/grants" || true; } ;;
      grant) arg --id "$@" >>"$S/grants"; echo >>"$S/grants"; echo '{}' ;;
      *) echo "fake az: unknown $*" >&2; exit 9 ;;
    esac ;;
  "ad app credential")
    id=$(arg --id "$@")
    case "$4" in
      list) { grep -c "^$id\$" "$S/creds" || true; } ;;
      reset) echo "$id" >>"$S/creds"; echo "S3CRET-$(grep -c "^$id\$" "$S/creds")-$id" ;;
      *) echo "fake az: unknown $*" >&2; exit 9 ;;
    esac ;;
  *) echo "fake az: unknown $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$tmp/bin/az"
export AZ_LOG="$tmp/az.log" AZ_STATE="$tmp/state" HOME="$tmp/home"
# TEST_PATH_PREFIX: a folder with another bash and date (bash 5 and GNU date, as in Cloud Shell).
BASE_PATH="${TEST_PATH_PREFIX:+$TEST_PATH_PREFIX:}/usr/bin:/bin"
FAKE_PATH="$tmp/bin:$BASE_PATH"

run() { : >"$AZ_LOG"; PATH="$FAKE_PATH" bash "$SCRIPT" "$@" >"$tmp/out" 2>&1; echo $? >"$tmp/rc"; }
calls() { sed 's/ --.*//' "$AZ_LOG" | tr '\n' ',' | sed 's/,$//'; }
has() { grep -qF -- "$1" "$tmp/out"; }

# 1. A new app: every call, in order, and the three values.
run https://box.example.com
want="account show,ad app list,ad app create,ad sp list,ad sp create,ad sp update,ad app permission list-grants,ad sp show,ad app permission grant,ad app credential list,ad app credential reset"
[ "$(cat "$tmp/rc")" = 0 ] && [ "$(calls)" = "$want" ] && ok "new app: calls in order" || { bad "new app: calls in order"; calls; echo; cat "$tmp/out"; }
grep -q -- "--sign-in-audience AzureADMyOrg --web-redirect-uris https://box.example.com/api/auth/oidc/callback" "$AZ_LOG" &&
  grep -q -- '"name":"auth_time"' "$AZ_LOG" &&
  grep -q -- '37f7f235-527c-4136-accd-4a02d197296e' "$AZ_LOG" && grep -q -- '14dad69e-099b-42c9-810b-d002981feec1' "$AZ_LOG" &&
  ok "new app: single tenant, redirect, auth_time, openid + profile" || bad "new app: create arguments"
grep -q -- "--display-name Mantle box.example.com" "$AZ_LOG" && ok "default display name from the host" || bad "default display name"
grep -q -- "--set appRoleAssignmentRequired=true" "$AZ_LOG" && ok "assignment required" || bad "assignment required"
grep -q -- '--scope openid profile' "$AZ_LOG" && ok "consent for openid profile only" || bad "consent scope"
has "Tenant ID:      11111111-1111-1111-1111-111111111111" && has "Client ID:      aaaaaaaa-0000-0000-0000-000000000001" &&
  has "Client secret:  S3CRET-1-aaaaaaaa-0000-0000-0000-000000000001" && has "Secret ends:" &&
  ok "new app: prints the three values and the end date" || { bad "new app: output"; cat "$tmp/out"; }
grep "credential reset" "$AZ_LOG" | grep -q -- "--append" && ok "reset always --append" || bad "reset without --append"
end=$(grep -o 'end-date [0-9-]*' "$AZ_LOG" | cut -d' ' -f2)
exp=$(date -u -d "+12 months" +%Y-%m-%d 2>/dev/null || date -u -v+12m +%Y-%m-%d)
[ "$end" = "$exp" ] && ok "default end date: 12 months" || bad "end date $end, want $exp"

# 2. Run again: reuse, no create, no new secret.
run https://box.example.com
want="account show,ad app list,ad app show,ad sp list,ad sp update,ad app permission list-grants,ad app show,ad app show,ad app credential list"
[ "$(cat "$tmp/rc")" = 0 ] && [ "$(calls)" = "$want" ] && ok "re-run: reuse, no create, no secret" || { bad "re-run calls"; calls; echo; cat "$tmp/out"; }
has "found and reused" && has "none made: the app has 1 already" && ! grep -q S3CRET "$tmp/out" &&
  ok "re-run: says reused, prints no secret" || { bad "re-run output"; cat "$tmp/out"; }

# 3. --new-secret on the reused app: one more secret, appended.
run --new-secret --months 6 https://box.example.com
has "Client secret:  S3CRET-2-" && grep "credential reset" "$AZ_LOG" | grep -q -- "--append" &&
  ok "--new-secret: a second secret, appended" || { bad "--new-secret"; cat "$tmp/out"; }
exp=$(date -u -d "+6 months" +%Y-%m-%d 2>/dev/null || date -u -v+6m +%Y-%m-%d)
grep -q -- "--end-date $exp" "$AZ_LOG" && ok "--months 6" || bad "--months 6"
[ "$(grep -c "^aaaaaaaa-0000-0000-0000-000000000001\$" "$AZ_STATE/creds")" = 2 ] && ok "no secret removed" || bad "creds count"

# 4. --list: two boxes (one known, one new), a comment and a blank line.
printf '# boxes\nhttps://box.example.com\n\n  https://other.example.com/  \n' >"$tmp/list.txt"
run --list "$tmp/list.txt"
[ "$(cat "$tmp/rc")" = 0 ] && [ "$(grep -c '^== ' "$tmp/out")" = 2 ] && has "== box.example.com ==" && has "== other.example.com ==" &&
  has "Client ID:      aaaaaaaa-0000-0000-0000-000000000002" && has "Client secret:  S3CRET-1-aaaaaaaa-0000-0000-0000-000000000002" &&
  [ "$(grep -c 'ad app create' "$AZ_LOG")" = 1 ] && ok "--list: one block per box, only the new box is made" || { bad "--list"; cat "$tmp/out"; }

# 5. The secret is in no file and on no command line.
if grep -rqF S3CRET "$tmp/state" "$tmp/home" "$AZ_LOG" "$tmp/list.txt" 2>/dev/null; then bad "secret found in a file"; else ok "secret in no file and in no az argument"; fi
grep -q 'set -x' "$SCRIPT" && bad "set -x in the script" || ok "no set -x"

# 6. Same name, other redirect URI: stop, change nothing.
printf 'Mantle third.example.com\tbbbbbbbb-0000-0000-0000-000000000001\thttps://elsewhere.example.com/api/auth/oidc/callback\n' >>"$AZ_STATE/apps"
run https://third.example.com
[ "$(cat "$tmp/rc")" != 0 ] && has "not with the redirect URI" && ! grep -q "ad app create\|credential reset" "$AZ_LOG" &&
  ok "name taken with another redirect: stops" || { bad "name clash"; cat "$tmp/out"; }

# 7. Not logged in; az missing; a URL with a path; a bad --months.
touch "$AZ_STATE/nologin"; run https://box.example.com; rm -f "$AZ_STATE/nologin"
[ "$(cat "$tmp/rc")" != 0 ] && has "az login --allow-no-subscriptions" && has "Cloud Application Administrator" && ok "not logged in: one plain line with the role" || { bad "not logged in"; cat "$tmp/out"; }
PATH="$BASE_PATH" bash "$SCRIPT" https://box.example.com >"$tmp/out" 2>&1
rc=$?
[ $rc != 0 ] && has "Azure CLI (az) is missing" && has "shell.azure.com" && ok "az missing: says so" || { bad "az missing"; cat "$tmp/out"; }
run https://box.example.com/mantle
[ "$(cat "$tmp/rc")" != 0 ] && has "no path" && ok "URL with a path: refused" || bad "URL with a path"
run --months 30 https://box.example.com
[ "$(cat "$tmp/rc")" != 0 ] && has "1 to 24" && ok "--months 30: refused" || bad "--months 30"

# 8. Dry run with no az on PATH and no login: prints the calls, changes nothing.
PATH="$BASE_PATH" bash "$SCRIPT" --dry-run https://box.example.com "Mantle test box" >"$tmp/out" 2>&1
rc=$?
[ $rc = 0 ] && has "  az ad app create --display-name 'Mantle test box' --sign-in-audience AzureADMyOrg" &&
  has "  az ad app credential reset --id '<client id>' --append" && has "Client secret:  <client secret>" &&
  ok "dry run: prints the calls with no az" || { bad "dry run"; cat "$tmp/out"; }

echo
[ $fails = 0 ] && echo "all passed" || echo "$fails failed"
exit $fails
