#!/bin/sh
# Media sidecar entrypoint.
#
# yt-dlp breaks the moment a site changes its player or signature scheme, and
# upstream ships fixes within days — a pinned copy does not degrade, it stops
# working. So this container inverts the repo's pin-everything posture ON
# PURPOSE: refresh from PyPI at boot, and again every 24h. The accepted cost
# (an unreviewed upstream release lands automatically) is exactly why this
# binary lives in its own container with no DB, secrets, or file-store access.
# Never curl|bash — pip from PyPI only. The running version is visible at
# /healthz so a stale or failed update shows up in system health.

set -u

refresh() {
  pip install --no-cache-dir --upgrade yt-dlp \
    && echo "[media] yt-dlp now $(yt-dlp --version)" \
    || echo "[media] yt-dlp refresh failed; keeping $(yt-dlp --version)"
}

# Best-effort at boot: an offline start still serves with the baked-in copy.
refresh

# Daily refresh, in the background for the life of the container.
(
  while true; do
    sleep 86400
    refresh
  done
) &

exec python /srv/app.py
