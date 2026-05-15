#!/usr/bin/env bash
# Open an SSH port-forward so local development can reach the remote
# Mantle Postgres as if it were on localhost:54322.
#
# The remote Postgres is bound to 127.0.0.1:5432 on the server (loopback
# only — never public). The tunnel forwards laptop 54322 → server 5432
# over the SSH connection. Drizzle, pg-boss, and the MCP server all
# point their DATABASE_URL at 127.0.0.1:54322 on the laptop side.
#
# Usage:
#   ./scripts/dev-tunnel.sh                  # foreground (Ctrl-C to close)
#   ./scripts/dev-tunnel.sh --background     # detach (writes PID file)
#   ./scripts/dev-tunnel.sh --stop           # kill the backgrounded tunnel
#
set -euo pipefail

HOST="${MANTLE_SSH_HOST:-cwe@mcp.crossworks.network}"
LOCAL_PORT="${MANTLE_LOCAL_DB_PORT:-54322}"
REMOTE_PORT="${MANTLE_REMOTE_DB_PORT:-5432}"
PID_FILE="${TMPDIR:-/tmp}/mantle-tunnel.pid"

case "${1:-}" in
  --stop)
    if [[ -f "$PID_FILE" ]]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "✓ tunnel stopped (pid $PID)"
      else
        echo "  (tunnel pid $PID not running)"
      fi
      rm -f "$PID_FILE"
    else
      echo "  (no tunnel pid file at $PID_FILE)"
    fi
    exit 0
    ;;
  --background)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "  tunnel already running (pid $(cat "$PID_FILE"))"
      exit 0
    fi
    ssh -N -f -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      "$HOST"
    # `ssh -f` daemonises; grab the new pid
    PID=$(pgrep -f "ssh -N.*${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}.*${HOST}" | head -1)
    echo "$PID" > "$PID_FILE"
    echo "✓ tunnel up: 127.0.0.1:${LOCAL_PORT} → ${HOST}:${REMOTE_PORT} (pid $PID)"
    exit 0
    ;;
  --help|-h)
    sed -n '2,/^set -euo/p' "$0" | sed -n '/^#/p' | sed 's/^# \?//'
    exit 0
    ;;
esac

# Foreground mode (default). Ctrl-C kills it.
echo "→ tunnel: 127.0.0.1:${LOCAL_PORT} → ${HOST}:${REMOTE_PORT}"
echo "  Ctrl-C to close; or use --background to daemonise"
exec ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  "$HOST"
