# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the multi-arch image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## v0.113.1 — 2026-07-03

**Centered page title, easier to read.** The floating title in the middle of
the header now uses the app font (Inter), smaller and bold, so longer titles
fit without truncating. The Bukhari script face is reserved for the wordmark.

## v0.113.0 — 2026-07-03

**Name your brain in the header.** A new **Site name** field in
Settings → Profile replaces the top-left "mantle" wordmark with your own
label — e.g. "Natref" — so when you run several brains it's obvious at a
glance which one you're looking at. Leave it blank to keep the Mantle
wordmark; the header updates immediately after saving.

## v0.112.1 — 2026-07-03

**Complete release notes, in the app and in the brain.** Every release from
v0.82.0 onward now has an entry under /docs → Changelog (the 0.82–0.96 era was
backfilled from git history; 0.103+ notes moved into the per-version files the
reader and the Changelog collection actually use). Also ships the dev-tooling
fixes below.

### `pnpm reset` actually wipes the dev brain again

**`pnpm reset` actually wipes the dev brain again.** Since the v0.103 move
to bind mounts, `docker compose down -v` stopped deleting the postgres +
minio data (bind mounts survive volume removal), so `pnpm reset` claimed a
wipe it no longer performed. `scripts/reset.sh` now deletes
`${MANTLE_DATA_DIR:-./data}/{postgres,minio}` explicitly (via a container,
so container-owned files on Linux don't need sudo), shows the resolved data
dir in the confirmation prompt, and honors a root `.env` the same way
compose does.

- Docs caught up with the bind-mount reality: `architecture.md` §15 no
  longer documents the retired `mantle_pg_data` / `mantle_minio_data` named
  volumes (disaster recovery = `down` + `rm -rf` the data dirs);
  `deploy.md` §4 exports dev MinIO/files data with a plain `tar` off disk.

### Dev compose can no longer collide with a live prod stack

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

## v0.112.0 — 2026-07-03

**Release notes your brain can read.** The changelog joins the documentation
system as a built-in collection: browsable under /docs and, once enabled
there, indexed by the brain — so "what changed in v0.99?" is answerable in
chat. Ships disabled by default; `_`-hidden folders stay out of every other
collection.

## v0.111.0 — 2026-07-03

**A calmer first screen, and frontend-only development.** The right-hand
Activity column starts hidden (expand with ⌘J; the choice sticks). New
`pnpm dev:fe` runs just the web app against a deployed brain — no local
Docker/Postgres; a box opts in via `MANTLE_API_CORS_ORIGINS` (plumbed through
compose). Runtime-verifying the detached path fixed three latent breaks
(layout onboarding gate, UsageCard's in-process DB read, cross-origin
credentialed fetches). First deployable image carrying v0.110.0.

## v0.110.0 — 2026-07-02

**Multiple admins, one brain** (untagged; ships in the v0.111.0 image).
Settings → Users manages additional full-admin logins (create / password
reset / delete) with a complete audit trail — logins, failed logins,
password changes, user management, and every mutating API call, attributed
to the acting login and durable past user deletion. Brain content stays
keyed to the anchor account; the anchor is undeletable, self-delete is
blocked, owner status is unreachable via the API.

## v0.109.3 — 2026-07-02

Completes the v0.109.2 sweep: the Tables grid's row/column IDs also used
`crypto.randomUUID()` bare (via `@mantle/content`'s table model), so table
editing would fail on plain-HTTP installs. Same fallback applied.

## v0.109.2 — 2026-07-02

**Assistant works on plain-HTTP installs.** Companion fix to v0.109.1:
browsers also remove `crypto.randomUUID`, `crypto.subtle`, the clipboard
API, and microphone access on non-HTTPS pages. The assistant composer
generated its idempotency key with `crypto.randomUUID()` and threw before
sending — pressing Submit silently did nothing. All client code now goes
through `lib/secure-context-fallbacks.ts` (UUID, sha256, copy-to-clipboard
fallbacks); voice input, which browsers hard-block over HTTP, shows a
clear "needs HTTPS" message instead of failing silently.

## v0.109.1 — 2026-07-02

**Login works on plain-HTTP installs.** On a no-domain install
(`MANTLE_SITE_ADDRESS=:80`, browsing by bare IP) the session cookie was
marked `Secure`, so browsers silently dropped it — login returned OK but
bounced straight back to the login screen, forever. Cookies (session +
Microsoft OAuth handshake) now take the `Secure` flag from the request's
actual scheme (`X-Forwarded-Proto`), so HTTPS installs behave exactly as
before and HTTP installs can actually sign in. Found on the first
Pinnacle machine. HTTPS remains strongly recommended — see
`docs/installation.md` for pointing a domain at the box.

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
