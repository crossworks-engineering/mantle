#!/usr/bin/env bash
# runs-on: Azure Cloud Shell (bash), or any machine with the Azure CLI. Keep it bash 3.2 and BSD-tool safe.
#
# entra-app-create.sh: make the Microsoft Entra app registration that a
# Mantle box needs for company sign-in (docs/oidc-entra.md, "With the script").
#
# A standalone helper for the tenant's IT person. It runs with their own
# Azure login (`az`), never on a box and never with a Mantle credential, and
# no Azure credential goes into a brain. It does steps 1 to 4 of the manual
# steps in docs/oidc-entra.md, for one box or for a list of boxes:
#   - the app registration, single tenant (AzureADMyOrg);
#   - the Web redirect URI <box URL>/api/auth/oidc/callback
#     (OIDC_CALLBACK_PATH in packages/config/src/oidc.ts);
#   - the optional claim auth_time on the ID token;
#   - the delegated Microsoft Graph permissions openid and profile (the box
#     asks for `openid profile` and nothing more), with admin consent for the
#     tenant, so nobody sees a consent prompt;
#   - the enterprise app (service principal) with "Assignment required" on;
#   - one client secret (added, never replacing another).
# It prints the three values for the Control Center page Fleet > Company
# sign-in: Tenant ID, Client ID, Client secret, and the secret's end date.
#
#   scripts/entra-app-create.sh [--dry-run] [--new-secret] [--months <n>] <box URL> [<display name>]
#   scripts/entra-app-create.sh [--dry-run] [--new-secret] [--months <n>] --list <file>
#
# <box URL>   the box's public address, https://box.example.com (MANTLE_PUBLIC_URL).
# <display name>  default "Mantle <host>", for example "Mantle box.example.com".
# --list <file>   one box URL per line (blank lines and # lines are skipped);
#                 each box gets the default display name.
# --months <n>    the secret's life in months, 1 to 24 (default 12). A tenant
#                 policy can allow less; then Entra refuses and says so.
# --new-secret    add a new secret to an app that has one already.
# --dry-run       print the az calls for a new app and change nothing. Needs
#                 no az and no login.
#
# Safe to run again. An app with the same display name AND the box's redirect
# URI is reused, as it is: the script reports what it lacks and does not
# change its settings. A reused app gets a new secret only with --new-secret
# (or when it has none). The script never deletes anything.
#
# The secret goes to this terminal once. It is held in a shell variable only:
# never in a file, never on a command line, never in shell history. Copy it
# into the Control Center at once; Entra never shows it again.
#
# Who may run it: an Entra role of Cloud Application Administrator or
# Application Administrator (both can grant the delegated consent for
# openid and profile; Application Developer cannot).
set -euo pipefail
set +x # never trace: a trace would print the secret

GRAPH_APP_ID=00000003-0000-0000-c000-000000000000
GRAPH_OPENID=37f7f235-527c-4136-accd-4a02d197296e
GRAPH_PROFILE=14dad69e-099b-42c9-810b-d002981feec1
CALLBACK_PATH=/api/auth/oidc/callback
OPTIONAL_CLAIMS='{"idToken":[{"name":"auth_time","essential":false}]}'
REQUIRED_ACCESS='[{"resourceAppId":"'$GRAPH_APP_ID'","resourceAccess":[{"id":"'$GRAPH_OPENID'","type":"Scope"},{"id":"'$GRAPH_PROFILE'","type":"Scope"}]}]'
ROLE_HINT="You need the Entra role Cloud Application Administrator (or Application Administrator)."

die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '/^#   scripts\/entra-app-create.sh/p' "$0" | sed 's/^#   //' >&2; exit 2; }

DRY=0; NEW_SECRET=0; MONTHS=12; LIST=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --new-secret) NEW_SECRET=1; shift ;;
    --months) MONTHS=${2:-}; shift 2 || usage ;;
    --list) LIST=${2:-}; shift 2 || usage ;;
    -h|--help) usage ;;
    -*) echo "✗ unknown option: $1" >&2; usage ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
case "$MONTHS" in ''|*[!0-9]*) die "--months takes a whole number from 1 to 24" ;; esac
[ "$MONTHS" -ge 1 ] && [ "$MONTHS" -le 24 ] || die "--months takes a whole number from 1 to 24"
if [ -n "$LIST" ]; then
  [ ${#ARGS[@]} -eq 0 ] || die "give --list or one box URL, not both"
  [ -r "$LIST" ] || die "cannot read the list file: $LIST"
else
  [ ${#ARGS[@]} -ge 1 ] && [ ${#ARGS[@]} -le 2 ] || usage
fi

# fd 3 is the terminal's stdout, also inside $( ): the dry-run lines go there.
exec 3>&1

# One argument, quoted so a person can read and paste it.
quote() {
  case "$1" in
    *\'*) printf '"%s"' "$(printf '%s' "$1" | sed 's/[$`"\\]/\\&/g')" ;;
    *[!A-Za-z0-9_./:=@,+-]*|'') printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# az_call <dry-run answer> <az args...>: run az, or in a dry run print the
# call and answer with the placeholder. A failure stops the script with the
# role hint (most failures in a tenant are a missing role).
az_call() {
  local fake=$1; shift
  if [ "$DRY" = 1 ]; then
    local line="  az" a
    for a in "$@"; do line="$line $(quote "$a")"; done
    printf '%s\n' "$line" >&3
    [ -z "$fake" ] || printf '%s\n' "$fake"
    return 0
  fi
  if ! az "$@" --only-show-errors; then
    echo "✗ az ${*:1:4} failed (see the error above). $ROLE_HINT" >&2
    echo "  Boxes printed before this one are done. Run the same command again: done boxes are reused." >&2
    exit 1
  fi
}

# az_retry: as az_call, but tries 5 times, 10 s apart. Entra takes some
# seconds to see a new app or service principal everywhere.
az_retry() {
  local fake=$1; shift
  if [ "$DRY" = 1 ]; then az_call "$fake" "$@"; return 0; fi
  local n=1
  while ! az "$@" --only-show-errors; do
    [ $n -lt 5 ] || { echo "✗ az ${*:1:4} failed 5 times. $ROLE_HINT" >&2; exit 1; }
    echo "  (Entra is not ready yet; trying again in 10 s)" >&2
    sleep 10; n=$((n + 1))
  done
}

end_date() { # today plus MONTHS months, YYYY-MM-DD (GNU date, then BSD date)
  date -u -d "+$MONTHS months" +%Y-%m-%d 2>/dev/null || date -u -v+"$MONTHS"m +%Y-%m-%d
}

# ---------------------------------------------------------------- checks
TENANT="<tenant id>"
if [ "$DRY" = 0 ]; then
  command -v az >/dev/null 2>&1 ||
    die "The Azure CLI (az) is missing. Open Azure Cloud Shell (bash) at https://shell.azure.com and run this there."
  TENANT=$(az account show --query tenantId -o tsv 2>/dev/null) && [ -n "$TENANT" ] ||
    die "az is not logged in. Run: az login --allow-no-subscriptions   $ROLE_HINT"
else
  echo "Dry run: no az call is made. This is what a run for a NEW app does."
fi

# ---------------------------------------------------------------- one box
one_box() {
  local url=$1 name=${2:-}
  url=${url%/}
  echo "$url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' ||
    die "not a box URL: $url (use https://<host>, no path; the box adds $CALLBACK_PATH)"
  local host=${url#https://}
  [ -n "$name" ] || name="Mantle $host"
  local redirect="$url$CALLBACK_PATH"
  local odata_name=${name//\'/\'\'}

  echo
  echo "== $host =="

  # 1. Find an app with this display name, then check its redirect URI.
  local ids app="" state n=0 id has
  ids=$(az_call "" ad app list --filter "displayName eq '$odata_name'" --query "[].appId" -o tsv)
  for id in $ids; do
    n=$((n + 1))
    has=$(az_call "" ad app show --id "$id" --query "contains(web.redirectUris || \`[]\`, '$redirect')" -o tsv)
    if [ "$has" = true ]; then
      [ -z "$app" ] || die "two apps named \"$name\" hold $redirect. Pick one by hand, or pass another display name."
      app=$id
    fi
  done
  if [ -n "$app" ]; then
    state="found and reused (its settings are not changed)"
  elif [ $n -gt 0 ]; then
    die "an app named \"$name\" exists, but not with the redirect URI $redirect. Check it by hand, or pass another display name."
  else
    # 2. Make the app: single tenant, redirect URI, auth_time, openid + profile.
    app=$(az_call "<client id>" ad app create --display-name "$name" \
      --sign-in-audience AzureADMyOrg --web-redirect-uris "$redirect" \
      --optional-claims "$OPTIONAL_CLAIMS" --required-resource-accesses "$REQUIRED_ACCESS" \
      --query appId -o tsv)
    state="made new"
  fi

  # 3. The enterprise app (service principal): make it when missing.
  local sp
  sp=$(az_call "" ad sp list --filter "appId eq '$app'" --query "[].id" -o tsv)
  if [ -z "$sp" ]; then
    sp=$(az_retry "<service principal id>" ad sp create --id "$app" --query id -o tsv)
  fi

  # 4. Assignment required: only assigned people and groups may sign in.
  az_retry "" ad sp update --id "$sp" --set appRoleAssignmentRequired=true >/dev/null

  # 5. Admin consent for openid and profile, once.
  local grants graph
  grants=$(az_call "0" ad app permission list-grants \
    --filter "clientId eq '$sp' and consentType eq 'AllPrincipals'" --query "length(@)" -o tsv)
  if [ "${grants:-0}" = 0 ]; then
    graph=$(az_call "<graph service principal id>" ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)
    az_retry "" ad app permission grant --id "$sp" --api "$graph" --scope "openid profile" >/dev/null
  fi

  # 6. What a reused app lacks: report only, change nothing.
  local missing=""
  if [ "$DRY" = 0 ] && [ "${state#found}" != "$state" ]; then
    has=$(az_call "" ad app show --id "$app" --query "length(optionalClaims.idToken[?name=='auth_time'] || \`[]\`)" -o tsv)
    [ "$has" != 0 ] || missing="$missing
  - The auth_time claim on the ID token (docs/oidc-entra.md, step 3)."
    has=$(az_call "" ad app show --id "$app" --query "signInAudience" -o tsv)
    [ "$has" = AzureADMyOrg ] || missing="$missing
  - Single tenant: the app's account type is $has, not AzureADMyOrg."
  fi

  # 7. The secret: new app, --new-secret, or an app with no secret.
  local count secret="" end=""
  count=$(az_call "0" ad app credential list --id "$app" --query "length(@)" -o tsv)
  if [ "$NEW_SECRET" = 1 ] || [ "${count:-0}" = 0 ]; then
    end=$(end_date)
    secret=$(az_call "<client secret>" ad app credential reset --id "$app" --append \
      --display-name "Mantle sign-in" --end-date "$end" --query password -o tsv)
  fi

  printf '%s\n' "App:            $name, $state" \
    "Redirect URI:   $redirect" \
    "Paste into the Control Center, Fleet > Company sign-in:" \
    "  Tenant ID:      $TENANT" \
    "  Client ID:      $app"
  if [ -n "$secret" ]; then
    printf '  Client secret:  %s\n' "$secret"
    printf '%s\n' "Secret ends:    $end. Put this date in a calendar now: sign-in stops on it."
  else
    printf '%s\n' "  Client secret:  none made: the app has $count already. Use the one you saved," \
      "                  or run again with --new-secret."
  fi
  secret=""
  [ -z "$missing" ] || printf '%s\n' "This reused app lacks (fix by hand):$missing"
  printf '%s\n' "By hand: assign the people or groups who may sign in" \
    "  (Entra ID > Enterprise apps > $name > Users and groups)."
}

if [ -n "$LIST" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(printf '%s' "$line" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')
    case "$line" in ''|'#'*) continue ;; esac
    one_box "$line" </dev/null
  done <"$LIST"
else
  one_box "${ARGS[0]}" "${ARGS[1]:-}"
fi

echo
echo "Not done by this script: SCIM needs a second app (docs/scim-entra.md)."
