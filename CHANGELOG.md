# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the multi-arch image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## v0.109.1 — 2026-07-02

**Dev compose can no longer collide with a live prod stack.** The dev
compose (`docker-compose.dev.yml`) gets its own project name (`mantle-dev`)
and container names (`mantle_dev_pg` / `mantle_dev_minio` / `mantle_dev_tika`).
Previously it shared project `mantle` and the exact container names with the
prod `docker-compose.yml`, so bringing dev infra up on a host that also runs
a prod stack recreated the prod containers and took the live brain down
(2026-07-02 dev-box incident). Host ports are unchanged (54323 / 9000 / 9001
/ 9998), so existing `.env.local` files keep working.

- One-time migration on dev machines: old containers block the ports —
  `pnpm start` detects them and tells you to run
  `docker compose -p mantle -f docker-compose.dev.yml down` once (data is
  bind-mounted under `./data` and is reused as-is).
- `db-dump.sh` / `db-restore.sh` / `trace-node.sh` now autodetect the
  running container (`mantle_dev_pg` vs `mantle_pg`) and refuse to guess
  when both exist on one host; `MANTLE_PG_CONTAINER` still overrides.
- `sanity.sh` falls back to the `mantle-dev` project when the prod project
  has no containers.

## v0.109.0 — 2026-07-02

**One install path.** The curl-able root `install.sh` now only bootstraps
(fetches the deploy bundle) and delegates configuration, startup, and
verification to the bundled `scripts/install.sh` — the same script used to
reconfigure a box later (`--domain`, `--check`). The deploy bundle now ships
`scripts/install.sh` + `scripts/sanity.sh`.

- `scripts/install.sh` gains `POSTGRES_PASSWORD` generation (kept on
  re-runs) and 80/443 port-in-use warnings.
- A release-tag `MANTLE_CHANNEL` now pins `MANTLE_IMAGE_TAG` to the same
  version, so bundle and image can't drift apart.
- Docs refreshed to match the product: online embedder default, the current
  onboarding wizard (system-status gate, Models, Memory), Sonnet 5 defaults,
  and this changelog added.

## v0.108.0 — 2026-07-02

- **Claude Sonnet 5 is the shipped default** for the assistant and the
  Sonnet-class specialists ($2/$10 per M tokens, 1M context — newer and
  cheaper than Sonnet 4.6). Existing brains: specialists move on upgrade;
  your assistant's model is operator-owned and never touched.
- Onboarding's OpenAI card is now GPT-5.5 (Azure-capable). Catalogs,
  pricing, and context tables updated for the new models.

## v0.107.2 — 2026-07-02

- **Fix:** re-saving an API key (e.g. resuming onboarding with a key already
  stored) hit a unique-constraint error that surfaced as a silent no-op.
  `setApiKey` now updates the existing key in place — with the ciphertext
  resealed against the existing row (AAD-safe).
- Onboarding surfaces request errors as toasts instead of swallowing them.

## v0.107.1 — 2026-07-02

- **Fix:** "Save & test" genuinely validates OpenRouter keys now — the
  models catalog is public (returns 200 for any key), so the probe validates
  against `GET /api/v1/key` first (bad keys get a clear 401 rejection).
- With a saved key and an empty field, the primary button becomes
  **Test saved key** instead of sitting disabled.

## v0.107.0 — 2026-07-02

- Onboarding's system-status panel gains a **Domain & HTTPS** row: proof-by-
  usage when you're browsing via the configured domain; DNS + server-side
  fetch verification otherwise.
- **Fix:** the installer never wrote `MANTLE_PUBLIC_URL`, so share/email
  links on installed boxes fell back to localhost. It's now derived from the
  chosen domain.

## v0.106.1 — 2026-07-02

- **Fix:** `text-embedding-3-large` via OpenRouter returned native 3072-dim
  vectors (the dimension parameter wasn't forwarded). The adapter now sends
  OpenAI's `dimensions` param and additionally truncates + renormalises
  (MRL) client-side, so the brain's 768-dim columns are always satisfied.

## v0.106.0 — 2026-07-02

- **System-status gate on onboarding step 1** — probes PostgreSQL, the
  pg-boss job schema, MinIO + bucket, Tika, and required secrets before the
  wizard begins; failures block Continue with a pointer to
  `scripts/sanity.sh`. A half-started stack now announces itself on the
  first screen instead of failing confusingly mid-wizard.

## v0.105.0 — 2026-07-02

- **Models step in onboarding** — curated, explained cards for the
  assistant's top-tier model and the background workers' fast model, running
  via OpenRouter (default, reuses your key) or **Azure OpenAI** (endpoint +
  key; OpenAI-family models). Choices apply at provision; everything remains
  changeable in Settings.

## v0.104.0 — 2026-07-01

- **Memory step in onboarding** — pick the embedding model
  (`text-embedding-3-large` recommended, `-small` budget) and route
  (OpenRouter — reusing the chat key, or OpenAI direct). The route is probed
  at 768 dims before the brain is pointed at it.

## v0.103.0 — 2026-07-01

- **Online embedder is the product default**; the local Ollama embedder is
  opt-in behind the `local-embedder` compose profile and no longer gates
  first boot (fixes fresh installs hanging on the model pull on restricted
  networks).
- **All persistent data bind-mounts under `MANTLE_DATA_DIR`** — postgres,
  minio, files, backups, app-dbs, Caddy certificates, ollama models. Nothing
  lives in named Docker volumes; `down -v` can't destroy data, and Caddy
  certs survive redeploys (no Let's Encrypt re-issuance).
- New `scripts/install.sh` (interactive + scriptable configurator with a
  DNS pre-check before enabling TLS) and `scripts/sanity.sh` (per-service
  health check with a clear pass/fail summary).
