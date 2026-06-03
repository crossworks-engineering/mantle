# Session changelog — 2026-06-01 (Contabo go-live + polish)

The session that took Mantle from "containerized but never deployed" to **live on
the Contabo VPS** (https://jason.crossworks.network), then fixed a string of
things the first real production run + first real UI walkthrough surfaced.
21 commits on `main`, `e4ae962 … c21c428`. Companion docs linked per section.

---

## 1. Production deploy — the 3 prod-only bugs

The container stack had never actually run end-to-end; three bugs that **only
manifest in a real prod container** (never under `next dev`) had to be fixed live.
Full writeup: [`handoff-deploy-contabo-2026-06-01.md`](./handoff-deploy-contabo-2026-06-01.md).

- **`e4ae962`** web crash-loop: the image CMD `pnpm … start -- -H …` — pnpm 10/11
  forwards `--` to `next start`, which read `-H` as a directory. Switched to the
  `exec` form.
- **`7910e2a`** the killer: `packages/db/src/client.ts` exported `db` as a Proxy
  but cached the pool on `globalThis` only when `NODE_ENV !== 'production'`. In
  prod **every query minted a new pool** → ~12 conns/sec → Postgres exhausted →
  whole-stack cascade. Cached unconditionally. *Why dev never saw it: the cache
  was active there.*
- **`271367d`** raised `max_connections` 100→200 (headroom found while debugging).
- **`825b663`** telegram-poll survives a transient `PostgresError` instead of
  crash-looping (the cascade amplifier); `unhandledRejection` backstops added to
  all workers + the agent.

## 2. Dashboard "System vitals" — two new pills

- **`d1a74a8`** **Embedder** pill: probes the configured embedder; for `local`
  it GETs the Ollama `/models` and confirms the model is loaded
  (`embeddinggemma:latest · loaded`).
- **`d30f101`** **Tailnet** pill: reads tailscaled status; muted/disabled when the
  tailnet's off (the normal dev resting state), green when `Running`.

## 3. Corpus audit — made honest (`/debug/integrity`)

First real-brain run showed **668 violations** — but ~all were check-naïveté or
pre-fix sediment, not live bugs (the key post-migration check, embedding-dim
drift, *passed*). See [`project_integrity_probe` memory] for the full reasoning.

- **`e7431e1`** policy-aware `half_indexed` (excludes telegram + conversation-digest
  notes, both unembedded by design; and files with no text layer) + a **per-check
  recency span** chip (muted = old sediment, highlighted = possible live
  regression). 198→8.
- **`d64b8c6`** `unembedded_facts` scoped to *valid* facts (the 1322 flagged were
  all retired). 1322→0.
- **`48d7a12`** **the judgment call:** `orphan_entities` (562) + `reaper_miss_facts`
  (27) turned out to be **real data, not residue** — named entities (Alan Kay,
  …) and valid personal facts. So instead of deleting (the original "backfill"
  plan), the checks were softened to flag only true residue / retired facts.
  **Zero real data deleted.** Lesson baked in: *sample flagged rows before any
  destructive cleanup.* 668 → 16 (all low-severity + real).
- Probe fixes: **`f9aaa88`** file fixtures resolve their sample dir regardless of
  cwd (every file fixture had reported MISSING under the web server's cwd);
  **`ee99736`** the probe email account is created `enabled=false` (stops the
  email-sync worker spamming connect errors); **`9fa6800`** embedder readiness
  reads `embedding_config` not `ai_workers` (it always showed "off");
  **`894861d`** aligned the probe results table into fixed grid columns.

## 4. Tailscale UI-activation — new feature

Store the Tailscale auth key in the vault and **Activate/Deactivate the tailnet
from `/settings/network`** — no more SSH + `.env` edit. Safe because single-user.
Canonical doc: [`tailscale.md` §UI-activation](./tailscale.md). Memory:
`project_tailscale_ui_activation`.

- **`bd6214b`** migration 0064 `tailscale_config` (singleton, sealed key) + the
  store + `tailnetUp`/`tailnetDown` driving tailscaled's LocalAPI over the socket.
- **`fc95b6a`** compose: the sidecar runs **always-up unauthenticated**
  (dropped the `tailnet` profile), socket mounted **RW**, image pinned `v1.98.4`,
  `TS_AUTH_ONCE`, relaxed healthcheck.
- **`b93dc60`** the Activate card + server actions; polls status for `Running`.
- **Open gate:** whether tailscaled accepts the app's *write* calls over the
  shared socket is verified live on the VPS (paste a key → Activate). If `/start`
  is rejected, fall back to the `file:` authkey transport — UI/schema unchanged.

## 5. Provider wired-detection — regression fix

`isProviderWired` read the *live* adapter registry, which is empty in the
browser bundle since the prod-build client/server split (`5dfaa0d`) moved the UI
to the adapter-free `@mantle/voice/client` leaf → **every provider showed "not
wired yet"** across the worker + agent forms.

- **`0a8458c`/`c21c428`** static `WIRED_PROVIDERS` table (browser-visible) unioned
  with the live registry; a drift test keeps it honest. Dropped the confusing
  `openai`-chat carve-out (OpenAI chat is via OpenRouter). See
  [`adding-a-provider.md`](./adding-a-provider.md) — adding an adapter now
  includes updating that table.

## 6. Docs + ops

- **`edc4cdd`** [`update-prod.md`](./update-prod.md) — the build-on-VPS update
  runbook (deploy.md §5 only covered registry-pull, which this box doesn't use).
- **`740fc1d` / `04fc824`** deploy-handoff updates.

---

## Config/data changes applied directly (not in git)

- **Ingest workers → cloud.** extractor/summarizer/reflector flipped from the
  local LM Studio gemma box to OpenRouter `google/gemini-3.1-flash-lite` (their
  existing backup promoted to primary) after the box hit `n_ctx: 4096` errors and
  was too slow. Local path stays proven + re-enable-able. Memory:
  `project_local_chat_live` (marked reverted). **Dev DB only — prod is a frozen
  pre-flip copy; flip prod the same way if it ever ingests.**
- **Telegram poller** stays **stopped on prod** (dev owns the bots) — `up -d`
  restarts it, so re-`stop worker_telegram` after every deploy. Memory:
  `project_telegram_dev_prod_poller_conflict`.
- Deduped 38 redundant `mentioned_in` edges on the dev brain (lossless).

## State at session end

Prod live + healthy (1951 nodes, connections flat, migration 0064 applied). Dev
on cloud ingest. This update (deploy of §2–§6) ships via `update-prod.md`.
