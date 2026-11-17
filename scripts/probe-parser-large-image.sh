#!/bin/bash
# runs-on: box. A Linux host with Docker (never the Mac), where a round builds the parser image.
# The PDF Agent's pictures of a page that is one very large image, in a
# built parser image with the limits compose gives the parser on a box
# (2 GB, no swap, 1 CPU). A made-up PDF (scripts/probe-parser-large-image.ts:
# one image of 99.8 M pixels, RGB and a soft mask) and two pdf-sheet-read
# jobs sent at once (the parser runs one, the other waits its turn in the
# queue). Both must end ok with their pictures drawn, none blank, and the
# container must count no memory kill. It prints the container's memory
# peak and the time of each job from its send, numbers only. The host needs
# cgroup v2 with memory.peak (kernel 5.19 or later).
#
#   scripts/probe-parser-large-image.sh <parser image> [name prefix]
#
# Docker on a Linux host (never the Mac). The container and the folder are
# named from the prefix and removed at the end.
set -u
I=${1:?usage: probe-parser-large-image.sh <parser image> [name prefix]}
P=${2:-probe}
REPO=$(cd "$(dirname "$0")/.." && pwd)
C=$P-parser-largeimage
T=$(mktemp -d)
cleanup() {
  docker rm -f "$C" >/dev/null 2>&1
  docker run --rm --network none --user 0 -v "$T":/t --entrypoint sh "$I" -c 'rm -f /t/large.pdf'
  rmdir "$T" 2>/dev/null
}
trap cleanup EXIT
docker run --rm --network none --user 0 -v "$T":/t \
  -v "$REPO/scripts/probe-parser-large-image.ts":/probe/make.ts:ro --entrypoint sh "$I" \
  -c 'bun --no-env-file /probe/make.ts /t/large.pdf && chmod 0644 /t/large.pdf' \
  || { echo "could not make the PDF"; exit 1; }
echo "pdf bytes: $(stat -c %s "$T/large.pdf")"
docker run -d --name "$C" --network none --init --read-only \
  --memory 2g --memory-swap 2g --cpus 1 --cpu-shares 512 --pids-limit 512 \
  --tmpfs /tmp:size=1g,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$T":/w:ro "$I" >/dev/null
ok=""
for _ in $(seq 1 30); do
  if docker exec "$C" bun --no-env-file -e "fetch('http://127.0.0.1:8095/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { docker logs "$C"; exit 1; }
docker exec "$C" bun --no-env-file -e "
  const fs = require('node:fs');
  const b = fs.readFileSync('/w/large.pdf');
  const request = { api: 1, step: 1, options: {}, asks: true, kind: 'isometric', state: { readerOptions: {} }, file: { name: 'large.pdf', ext: 'pdf', size: b.length, sha256: '0'.repeat(64) } };
  const opts = Buffer.from(JSON.stringify({ id: 'pdf-sheet-read', request }));
  const one = (t0 = Date.now()) => fetch('http://127.0.0.1:8095/pipeline/run', { method: 'POST', body: Buffer.concat([opts, b]), headers: { 'x-parser-opts-length': String(opts.length) } })
    .then((r) => r.json())
    .then((j) => ({ ok: j.ok === true, status: (j.result || {}).status, asks: ((j.result || {}).calls || []).length, pictures: (j.pictures || []).length, ms: Date.now() - t0, error: j.ok ? undefined : (j.error || {}).code }), (e) => ({ ok: false, error: String(e).slice(0, 80) }));
  Promise.all([one(), one()]).then((out) => {
    for (const o of out) console.log(JSON.stringify(o));
    process.exit(out.every((o) => o.ok && o.status === 'ok' && o.pictures === 4 && o.asks === 4) ? 0 : 1);
  });
" || { echo "a job did not end ok with its 4 pictures"; docker logs "$C"; exit 1; }
peak=$(docker exec "$C" cat /sys/fs/cgroup/memory.peak 2>/dev/null)
kills=$(docker exec "$C" sh -c "grep '^oom_kill ' /sys/fs/cgroup/memory.events 2>/dev/null | cut -d' ' -f2")
[ -n "$peak" ] && [ -n "$kills" ] || { echo "cannot measure on this host: no cgroup v2 memory.peak or memory.events"; exit 1; }
echo "peak MB: $((peak / 1048576)); memory kills: $kills"
[ "$kills" = 0 ] || { echo "the container counted a memory kill"; exit 1; }
state=$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$C")
[ "$state" = "true 0" ] || { echo "parser after the jobs: running/restarts = $state"; docker logs "$C"; exit 1; }
echo large-image-probe-ok
