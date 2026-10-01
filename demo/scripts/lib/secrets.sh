# The demo brain's four secrets. SOURCED by the demo scripts, from the repo root.
#
#   demo_secrets create    make any that are missing, then export all four
#   demo_secrets require   export all four; stop if one is missing
#
# They used to be constants in these scripts: a fixed session secret, a fixed
# master key and fixed passwords, committed to a public repository. That was
# sound while the brain held nothing real. It no longer is: the seed needs a
# real model key (main's onboarding refuses to finish without one), the vault
# seals it under the master key, and anyone can sign a session with a secret
# they can read on GitHub. So each checkout makes its own, once, in
# demo/.run/secrets (gitignored, mode 600), and nothing is committed.
#
#   session-secret    SESSION_SECRET: signs the session cookie the edge injects
#   master-key        MANTLE_MASTER_KEY: seals the vault; the level roles'
#                     database passwords are derived from it
#   owner-password    the demo owner's login (DEMO_OWNER_PASSWORD)
#   member-password   the member logins' password (DEMO_MEMBER_PASSWORD)
#
# The session secret and the master key are part of the BRAIN: the box that
# serves a bundle needs the same two values in its .env.demo, or every visitor
# meets a login screen and the vault stays shut. pack.sh says where they are.
#
# Only a FRESH seed creates. Every other script requires, because a brain
# sealed with one set of secrets and then opened with a newly made set fails
# in ways that look like bugs (a login loop, an unreadable key). A brain
# seeded before this file existed used the old fixed values: pass them in the
# environment (DEMO_SESSION_SECRET, DEMO_MASTER_KEY, DEMO_OWNER_PASSWORD), or
# re-seed.
#
# An environment value always wins over the file, so a bench can pin its own.

DEMO_SECRETS_DIR="${DEMO_SECRETS_DIR:-demo/.run/secrets}"

_demo_secret() { # <file name> <env override name> <mode> <generator command...>
  local name="$1" override="$2" mode="$3"; shift 3
  local file="$DEMO_SECRETS_DIR/$name" value="${!override:-}"
  if [ -z "$value" ]; then
    if [ ! -s "$file" ]; then
      if [ "$mode" != "create" ]; then
        echo "✗ no $file, and $override is not set." >&2
        echo "  This checkout has not seeded a brain since the demo's secrets stopped being" >&2
        echo "  committed constants. Run demo/scripts/seed.sh (a fresh seed makes them), or" >&2
        echo "  pass the value the brain was sealed with in $override." >&2
        return 1
      fi
      ( umask 077; mkdir -p "$DEMO_SECRETS_DIR"; "$@" > "$file" )
      echo "  made $file" >&2
    fi
    value="$(tr -d '\n' < "$file")"
  fi
  printf '%s' "$value"
}

# URL-safe random text, <n> random bytes of it.
_demo_random_text() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }
# Exactly 32 random bytes, base64: what MANTLE_MASTER_KEY must decode to.
_demo_random_key() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

demo_secrets() { # create | require
  local mode="${1:-require}"
  SESSION_SECRET="$(_demo_secret session-secret DEMO_SESSION_SECRET "$mode" _demo_random_text 48)" || return 1
  MANTLE_MASTER_KEY="$(_demo_secret master-key DEMO_MASTER_KEY "$mode" _demo_random_key)" || return 1
  DEMO_OWNER_PASSWORD="$(_demo_secret owner-password DEMO_OWNER_PASSWORD "$mode" _demo_random_text 24)" || return 1
  DEMO_MEMBER_PASSWORD="$(_demo_secret member-password DEMO_MEMBER_PASSWORD "$mode" _demo_random_text 24)" || return 1
  export SESSION_SECRET MANTLE_MASTER_KEY DEMO_OWNER_PASSWORD DEMO_MEMBER_PASSWORD
}
