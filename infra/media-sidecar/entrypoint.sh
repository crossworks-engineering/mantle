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
#
# The listener must bind IMMEDIATELY: on a box with slow/absent PyPI egress,
# an unbounded synchronous pip would hold the port closed for minutes and the
# healthcheck would mark the container unhealthy before it ever served. So
# every refresh — the boot one included — runs in the background with tight
# pip bounds, and the baked-in copy serves in the meantime.

set -u

# A SIGTERM'd python exits without running TemporaryDirectory finalizers, so
# in-flight partial downloads (up to 1 GB each) survive restarts in the
# writable layer. Sweep them before serving.
rm -rf /tmp/* 2>/dev/null || true

refresh() {
  pip install --no-cache-dir --retries 2 --timeout 10 --upgrade yt-dlp \
    && echo "[media] yt-dlp now $(yt-dlp --version)" \
    || echo "[media] yt-dlp refresh failed; keeping $(yt-dlp --version)"
}

# Boot refresh + daily loop, all backgrounded for the life of the container.
(
  refresh
  while true; do
    sleep 86400
    refresh
  done
) &

exec python /srv/app.py
