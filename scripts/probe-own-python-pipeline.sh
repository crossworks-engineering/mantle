#!/bin/bash
# runs-on: box. A Linux host with Docker (never the Mac), where a round builds the parser image.
# An own Python pipeline inside a built parser image (docs/pipelines.md,
# "Own pipelines"): the Python template copied into a temporary
# pipelines/<id>/<version> folder as root, 0644 and 0755, mounted read-only
# at /pipelines as compose mounts it, and one pipelineRun sent to the
# service. It reads the made-up sample, and the service is still up after.
#
#   scripts/probe-own-python-pipeline.sh <parser image> [name prefix]
#
# Docker on a Linux host (never the Mac). The container and the folder are
# named from the prefix and removed at the end.
set -u
I=${1:?usage: probe-own-python-pipeline.sh <parser image> [name prefix]}
P=${2:-probe}
REPO=$(cd "$(dirname "$0")/.." && pwd)
C=$P-parser-pyprobe
T=$(mktemp -d)
ID=lx9-logger-py
V=1.0.0
cleanup() {
  docker rm -f "$C" >/dev/null 2>&1
  docker run --rm --network none --user 0 -v "$T":/t --entrypoint sh "$I" -c 'rm -rf /t/pipelines'
  rmdir "$T" 2>/dev/null
}
trap cleanup EXIT
docker run --rm --network none --user 0 -v "$T":/t -v "$REPO/docs/pipeline-template/python":/src:ro --entrypoint sh "$I" -c "
  set -e; mkdir -p /t/pipelines/$ID/$V; cp -r /src/. /t/pipelines/$ID/$V/
  chown -R 0:0 /t/pipelines; find /t/pipelines -type d -exec chmod 0755 {} +; find /t/pipelines -type f -exec chmod 0644 {} +" \
  || { echo "could not lay out the package"; exit 1; }
ls -lR "$T/pipelines"
docker run -d --name "$C" --network none --init --read-only \
  --tmpfs /tmp:size=1g,mode=1777 --cap-drop ALL \
  -v "$T/pipelines":/pipelines:ro -e MANTLE_PIPELINES_DIR=/pipelines "$I" >/dev/null
ok=""
for _ in $(seq 1 30); do
  if docker exec "$C" bun --no-env-file -e "fetch('http://127.0.0.1:8095/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { docker logs "$C"; exit 1; }
echo "python: $(docker exec "$C" /opt/cad/bin/python --version 2>&1)"
docker exec -i "$C" sh -c 'cat > /tmp/sample.lx9' < "$REPO/docs/pipeline-template/sample.lx9"
docker exec "$C" bun --no-env-file -e "
  const fs = require('node:fs');
  const b = fs.readFileSync('/tmp/sample.lx9');
  const opts = Buffer.from(JSON.stringify({ id: '$ID', version: '$V', request: { api: 1, step: 1, file: { name: 'sample.lx9', ext: 'lx9', size: b.length, sha256: '' }, options: { max_rows: 200000 }, asks: false } }));
  fetch('http://127.0.0.1:8095/pipeline/run', { method: 'POST', body: Buffer.concat([opts, b]), headers: { 'x-parser-opts-length': String(opts.length) } })
    .then((r) => r.json())
    .then((j) => {
      const w = ((j.result || {}).calls || [])[0] || {}; const input = w.input || {};
      const tabs = (input.tabs || []).map((t) => [t.name, t.rows.length]);
      console.log(JSON.stringify({ ok: j.ok, status: (j.result || {}).status, tabs, error: j.error }));
      process.exit(j.ok && j.result.status === 'ok' && JSON.stringify(tabs) === JSON.stringify([['Readings', 3], ['Header', 2]]) ? 0 : 1);
    }, (e) => { console.log(String(e)); process.exit(1); });
" || { echo "the Python package did not read the sample"; docker logs "$C"; exit 1; }
sleep 2
state=$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$C")
[ "$state" = "true 0" ] || { echo "parser after the job: running/restarts = $state"; docker logs "$C"; exit 1; }
echo python-pipeline-probe-ok
