# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the multi-arch image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## v0.119.0 — 2026-07-07

**Tool calls stop being a wild card.** Until now, most of what kept an
agent's tool use correct was *prose* — descriptions asking the model to pass
the right types, call things in the right order, and report honestly. This
release moves those rules into enforced machinery, end to end (the full
architecture: [docs/tool-reliability.md](docs/tool-reliability.md)):

- **Every call is validated against the tool's own schema.** Harmless drift
  is repaired automatically (`"42"`→`42`, a bare value where a list belongs,
  stringified JSON); real violations produce *teaching errors* that name the
  field, what was expected, what arrived, and the closest valid alternative
  ("did you mean 'limit'?"), so the model fixes itself in one retry. Ships in
  **warn mode** (telemetry only, zero behaviour change); flip
  `MANTLE_TOOL_VALIDATION=enforce` per box once its violation profile has
  been reviewed.
- **Flail loops get cut short.** A call repeated verbatim after failing is
  warned at the 2nd failure and blocked at the 5th; a call that keeps
  returning the identical result is blocked as no-progress. Re-reads whose
  results change are never penalised.
- **The turn reports what actually happened.** When a turn runs out of tool
  budget, the model is handed the runtime's own ledger — "17 issued, 14
  succeeded, 2 failed, 1 queued for approval" — instead of being asked to
  remember. The same numbers appear under the reply in /assistant, with an
  always-visible notice when any call failed: the reply can no longer quietly
  omit a failure, and a queued action is never reported as done.
- **Outside content is fenced by provenance.** Results from user-authored
  HTTP tools — and recipes that ran one — are now wrapped in the same
  data-not-instructions fence as web pages, and error messages are scrubbed
  of instruction-framing (role tags, fake `[system]` markers) before the
  model reads them. A hostile API endpoint can no longer inject directives
  through either path. Fenced content itself is never rewritten — the
  boundary is the defense.
- **Outward-facing actions get the approval gate.** `email_send`,
  `email_page`, `page_share`, and `contact_delete` now default to operator
  approval on new brains (existing brains keep their settings — tighten
  per-tool in Settings → Tools).
- **Wrong-id calls teach instead of confusing.** Pages/tables tools check
  their ids up front and say exactly what's wrong — including the case no
  handler used to catch: "that id is a *note*, not a page."
- **Multi-block page edits are atomic.** New `page_blocks_apply` applies up
  to 50 block edits in one all-or-nothing call (one draft save; any failure
  aborts with the failing op named). The half-edited-draft failure mode from
  the v0.118.0 incident is now structurally impossible, and jobs like
  "wrap all 47 quotes" cost one call instead of ~95.

## v0.118.1 — 2026-07-06

**Boot reconcile works on multi-admin brains again.** Since the actor/anchor
split (v0.111.0), a brain with more than one admin had several `auth.users`
rows — and the boot reconcile's "single owner" check read that as an
unprovisioned install and silently skipped. Prompt, skill, and tool-group
updates stopped reaching those brains on upgrade. Owner resolution now keys on
the single anchor owner of the brain's content (with the old single-user check
as the fresh-install fallback), so upgrades propagate everywhere again.

## v0.118.0 — 2026-07-06

**Big page edits no longer die halfway.** A large SOP restructure on NATREF
exposed a chain of agent-editing failures, all fixed here:

- **Write batches are atomic.** The tool-loop's volume caps (40 calls/turn,
  15/tool) used to trip *mid-batch* — a 10-delete batch got cut at 1-of-10 and
  left the draft half-edited. Caps now enforce at batch boundaries: a batch
  that starts under its caps always completes; when the budget ends the turn,
  the model is told explicitly so it reports what's done vs what remains.
- **`page_blocks_list` no longer lies about drafts.** It listed the published
  doc while the block-edit tools worked on the draft — so an agent looking at
  a broken draft saw a clean page and said so. The listing now reads the same
  editing baseline as the edit tools and flags `has_draft` /
  `draft_updated_at`; `page_get` flags the draft too.
- **Right tool for the job.** The pages agent now picks its edit strategy by
  size: block tools for targeted fixes, one whole-body `page_update_draft`
  pass for big restructures (with the markdown table pitfalls documented — a
  `# | …` header row parses as a heading, not a table).
- **Per-agent tool budgets.** `memory_config.max_tool_calls` /
  `max_calls_per_tool` override the flat caps; the pages agent ships with
  100/40. Specialist `memoryConfig` now force-syncs on upgrade (like
  prompt/model/params), so existing brains get the new budgets.

## v0.117.0 — 2026-07-06

**Team Chat — your team can talk to your brain.** Team members (the same
Contacts you mint team tokens for) get their own chat at **/team**: they enter
their token once and can ask the brain anything it knows — project history,
documents, decisions — with attachments and live streaming, in a private
thread that remembers them. What they *can't* do is change anything: the team
responder is strictly read-only, and any "please update / fix / add this"
becomes a **request** in your review queue, where you (or a specialist) act on
it and send the reply straight back into their thread.

You stay in full control from the new **Team** screen (`/team-admin`): every
member's conversation is visible with unread badges, each answer links to its
full trace, open requests sit under their own tab, and a per-member access log
records every sign-in, question, and denial. Two guard rails worth knowing:
your **email and journal are excluded by default** — a clearly-labelled switch
(with a warning) is required before team answers may draw on them — and each
member is rate-limited with a daily turn cap, so a leaked token can't run up
your model bill. Revoking a member (or deleting the contact) cuts their access
instantly, mid-session.

## v0.116.2 — 2026-07-05

**The app docs caught up with the app platform.** The app-authoring guide (and
the matching Claude Code builder skill) now covers everything the recent
releases added: full-screen apps that own their own layout, the two share modes
and exactly what each one may do, per-app databases as a first-class store
(concurrent-safe, included in backups), and the assistant's read-only view over
app data. Release notes for 0.114.0–0.116.1 were also filled in under
/changelog.

## v0.116.1 — 2026-07-05

**Smoother concurrent access to app data.** App databases now use SQLite's
write-ahead logging, so reading and writing an app's data at the same time no
longer block each other. You'll notice it where it matters: a team-shared app
several people use at once, or the assistant reading an app's data while the app
itself is updating it — those now proceed without stalls or the occasional
"database is busy" hiccup.

## v0.116.0 — 2026-07-05

**Your assistant can read your apps' data.** If a mini-app keeps its own
database — a tracker, an inventory, a log — you can now just ask about it in
chat: *"how many open items in my tracker app?"*, *"what's in the inventory
table?"*. The assistant discovers which apps have data and reads it directly to
answer. It's **read-only** — the assistant can look but never change an app's
data — and it works across all your apps with no setup. (Apps with clearly named
tables and columns are the easiest for it to answer from.)

## v0.115.2 — 2026-07-05

**Your app data is now in the backup.** Mini-apps that keep their own database
(lists, trackers, anything an app stores) were living outside the regular
Postgres backup. The backup now snapshots every app database alongside it — a
consistent copy taken safely even while an app is in use — so a restore brings
your app data back with the rest of the brain. Nothing to do; it's part of the
standard backup from now on.

## v0.115.1 — 2026-07-04

**Shared apps got safer, and gained an activity log.** Public app links are now
strictly limited to the app's *own* data — they can no longer reach your notes,
email, or other brain tools, so a "public" app can never become a window into
your private information. Team-shared apps stay full-featured for the people you
name, and every open, tool call, and data write is logged on the app's Activity
tab so you can see exactly who did what. Also tightened: the token entry screen
is rate-limited, and shared apps can only use built-in tools (never arbitrary
web or shell calls).

## v0.115.0 — 2026-07-04

**Share a mini-app with your team, full-screen.** A published app's Share
control now offers two modes. A **public** link is open to anyone who has it; a
**team** link asks the visitor for their team token (from their contact) and
lets in only your team members — every action they take is recorded against
them, viewable on the app's new Activity tab. Either way the app now opens in a
real **full-screen** frame, so dashboards and multi-pane layouts get the whole
window instead of a small embedded box.

## v0.114.0 — 2026-07-04

**Contacts can now be team members.** A new "Team member" toggle on any contact
mints that person a short access token (shown once — regenerate or remove them
to revoke it). On its own it changes nothing you'll see day to day; it's the
foundation for sharing apps with specific people, where the token both lets them
in and records who they are. Membership is the single source of truth: flip the
toggle off, or delete the contact, and their token stops working everywhere.

## v0.113.4 — 2026-07-04

**The cursor shows the moment an H1 is inserted.** A just-inserted empty H1
collapsed to a zero-width box, so the (correctly coloured since v0.113.3)
caret had nowhere to paint until the first letter arrived. The heading now
keeps a one-character minimum width.

## v0.113.3 — 2026-07-04

**You can see the cursor in an empty H1 again.** The Pages H1 gradient's
transparent text colour also hid the caret, so a freshly inserted empty H1
looked focus-less though typing worked. The caret is now pinned to the
theme's primary colour.

## v0.113.2 — 2026-07-03

**One version, one place.** The version badge next to the header wordmark is
gone — it duplicated the sidebar changelog link, which stays and now carries
the full build-identity tooltip (version · git sha · build date).

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
