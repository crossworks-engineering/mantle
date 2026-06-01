# Updating production (build-on-VPS)

How to push the latest `main` to the Contabo box. This is the **build-on-VPS**
loop — the one that actually applies here, because the Mac builds **arm64** and
the VPS is **amd64**, so we never `docker compose pull` a registry image (it'd be
the wrong arch). deploy.md §5 describes the registry-pull flow; ignore it for
this box.

> **Box:** `ssh cwe@mcp.crossworks.network`, install dir `~/mantle`, serves
> https://jason.crossworks.network. See `reference_prod_box` / deploy.md for the
> full topology.

## What an update does

1. **rsync** the source from the Mac (`~/Projects/mantle`, `main`) to the VPS
   `~/mantle` — code only; data, `.env`, secrets are excluded and untouched.
2. **build** the single image natively on the VPS (`docker compose build web`)
   — bakes the new code + any new migrations into `titanwest/mantle:latest`.
3. **up** the stack (`docker compose up -d`) — the one-shot `migrate` service
   runs **pending DB migrations first** (gated), then web/agent/workers recreate
   on the new image.

Code is forward-and-back; **migrations are forward-only** — always dump first.

---

## Steps

```bash
# ── 0. (Mac) make sure main is current ───────────────────────────────────────
cd ~/Projects/mantle && git checkout main && git pull --ff-only   # if you push
git log --oneline -1                                              # the sha you're shipping

# ── 1. (VPS) BACK UP THE BRAIN before any migration — cheap insurance ────────
ssh cwe@mcp.crossworks.network 'cd ~/mantle && bash scripts/db-dump.sh'   # → backups/mantle-<ts>.dump

# ── 2. (Mac) rsync code → VPS (excludes data/.env/secrets/build artifacts) ───
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude '.claude' --exclude 'data' --exclude 'backups' \
  --exclude '.env' --exclude '*/.env.local' --exclude '*.dump' --exclude '*.tgz' \
  ~/Projects/mantle/ cwe@mcp.crossworks.network:~/mantle/
#   --delete removes files deleted from main; excluded paths (data/, .env, …)
#   are NEVER touched, so the prod brain + secrets are safe.

# ── 3. (VPS) rebuild the image natively (amd64). ~5–10 min ───────────────────
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose build web'

# ── 4. (VPS) roll the stack — migrate runs first, then app services recreate ─
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose up -d --wait'

# ── 5. (VPS) re-stop the telegram poller — `up -d` restarts it; dev owns bots ─
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose stop worker_telegram'
```

## Verify

```bash
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose ps'        # all up/healthy
ssh cwe@mcp.crossworks.network 'docker logs mantle_migrate 2>&1 | tail'  # migration applied (or no-op)
ssh cwe@mcp.crossworks.network 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from nodes"'  # unchanged
curl -sI https://jason.crossworks.network | head -3                       # 307 → /login, valid cert
# connections stay flat (~20, not climbing):
ssh cwe@mcp.crossworks.network 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from pg_stat_activity"'
```
Then in the browser: `/debug` (System vitals shows the **Embedder** + **Tailnet**
pills), `/debug/integrity` → Corpus audit (should be low/clean with the policy-aware
checks), `/settings/network` (the new **Activate Tailscale** card).

## Gotchas

- **telegram poller**: `up -d` restarts `worker_telegram`; re-`stop` it (step 5)
  while dev owns the bots, or you'll get the 409 conflict again.
- **tailscale sidecar now always-up**: this update's compose drops the `tailnet`
  profile, so `up -d` starts `mantle_tailscale` (pulls `v1.98.4`) — that's
  intended (powers the new UI activation). It runs unauthenticated until you
  Activate from `/settings/network`.
- **migration 0064** (`tailscale_config`) ships in this update — that's why the
  pre-dump matters.
- **build cache**: only changed layers rebuild; a code-only change re-runs
  `next build` but reuses node_modules. First build after a `pnpm-lock` change is
  slower.

## Rollback

Code: re-rsync the previous sha + rebuild + `up -d`. **Schema is forward-only** —
to undo a migration, restore the pre-update dump into a fresh DB (deploy.md §3b–c).
