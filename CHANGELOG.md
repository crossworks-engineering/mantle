# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the `linux/amd64` image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## v0.201.0 — 2026-07-24

**The member carve — the split now covers the team surfaces.** `/team`,
`/hub` and the owner's `/team-admin` move off the server app into the client
tier, completing what v0.200.0 started: the server app's UI is now render
surfaces only (`/s/<token>` shares, `/print`, the login stub).

- **The team credential goes bearer-shaped.** The signed team-chat value is
  minted either as the classic cookie (same-origin) or as a bearer
  (`POST /api/team/auth {mode:'bearer'}`, held by the client app and sent as
  `Authorization`). One format, two carriers; the same per-request membership
  liveness — revoking a member still locks them out mid-session — and the
  raw-contact-token bearer (the MS Teams seam) is untouched. No ambient
  credential cross-origin means no CSRF surface.
- **Members ride the client origin.** The workspace, forum and hub fetch
  through the new `@mantle/web-ui/team-fetch` transport; live turn streaming
  is a fetch-based SSE reader (Last-Event-ID resume) because EventSource
  can't carry a bearer. Old `/team` bookmarks redirect from the server
  origin; members re-enter their 8-char token once (deliberate: forwarding a
  30-day credential through a URL fragment was rejected — fragments land in
  history and session stores).
- **Share reading hops origins safely.** Opening a briefing/team share from
  the client origin goes top-level through `POST /api/team/sso` — the bearer
  rides the form BODY (never a URL), a fresh server-origin cookie is minted,
  and `/s/<token>` renders exactly as before. Cross-origin iframes are not
  used (they can never carry the cookie, and third-party cookies are dying).
- **The designated hub app stays first-class**: the sandbox host page
  attaches the bearer to the app brokers (`bundle`/`tool-broker`/
  `db-broker`), which now accept it and answer CORS preflights — only those
  three `/s` sub-paths, nothing else.
- **`/team-admin` under the owner bearer**: per-tab `GET /api/team-admin/*`
  routes + a client page; "mark read" is now an explicit action, not a render
  side effect.
- e2e grows `team-bearer.spec` (exchange, cookie-free workspace, SSO
  open-redirect table, broker CORS scoping) + a team-admin smoke; the full
  suite gates both topologies.

## v0.200.0 — 2026-07-24

**The true server/client split.** Mantle is now TWO applications shipped as two
images from one lockstep release: **`mantle-server`** — the headless backend
(the full `/api/**` surface, the DBOS runner, every worker, and the public
surfaces: `/s/<token>` shares, the `/team` workspace, `/hub`, PDF print) — and
**`mantle-client`** — the owner UI, a ZERO-SECRET Next app holding no database
connection, no session secret, and no server code, driving the server origin
purely over bearer + CORS. Run the server alone for a headless brain; point any
client at any server via one env var (`MANTLE_SERVER_ORIGIN`, read per-request
— one prebuilt client image serves every box).

Under the hood: the owner web session is a first-class bearer (30-day tokens
via `POST /api/auth/token`, atomic rotation via `/token/refresh`, per-device
revocation with a **Signed-in devices** panel under Settings → Security); PDF
export works over ANY auth transport (the exporter mints its own short-lived
internal render cookie for the Chromium sidecar); the shared UI layer lives in
`packages/web-ui`; and an ESLint boundary makes a server-value import in the
client tier a build error. Deploys: `docker-compose.yml` (server) +
`docker-compose.client.yml` (client) share one `.env` and one
`MANTLE_IMAGE_TAG`; the server Caddy gains an `app.<domain>` vhost
(`MANTLE_CLIENT_SITE_ADDRESS`); the updater rolls and drift-checks both stacks.
A new end-to-end Playwright net (owner flows, SSE, asset tokens, shares, team
tokens, PDF, mini-app sandbox — run in BOTH topologies) gates the whole arc,
and set `MANTLE_PUBLIC_URL` on every box: the `NEXT_PUBLIC_APP_URL` server-side
fallback is deprecated.

## v0.160.2 — 2026-07-23

**Postgres 18 is the default; Tika and Chromium bumped.** The bundled database moves
to PostgreSQL 18 (pgvector `pg18` = PG 18.4 + pgvector 0.8.5) — fresh installs come
up on 18 directly. Postgres 17 → 18 is a *major* upgrade for an existing box (it
needs a dump/restore, not a tag swap), so the image is env-gated via
`POSTGRES_IMAGE_TAG` (default `pg18`; pin `pg17` to defer), and the service now sets
`PGDATA=/var/lib/postgresql/data` — the pg18 images moved the default data path and
otherwise refuse the existing bind mount. Full per-box migration runbook and rollback
in [`docs/postgres-18-upgrade.md`](docs/postgres-18-upgrade.md). Also bumped: Apache
Tika `3.3.0.0 → 3.3.1.0`, browserless/chromium `v2.54.2 → v2.55.0`, and the Ollama
(`0.32.2`) and Tailscale (`v1.98.9`) default image pins.

## v0.137.0 — 2026-07-16

**Tables v2.2: export formats + linked reference columns.** Export any table
straight from the grid via a format dropdown — **Excel (`.xlsx`)**, **Markdown**,
or **CSV** (a multi-tab workbook exports every tab). Linked **reference
columns** (`type: 'reference'`, from v2.1) gain a first-class grid affordance: a
🔗 menu on a linked column header to **Change source…** or **Delete link**
(unlink keeps the cell values as plain text). A reference is a convenience
picker — the chosen value is copied as plain text, Excel data-validation style,
so `table_sql` sees an ordinary column; soft integrity flags values missing
from the source as `DANGLING REFS` in the profile, and removing a source
degrades the column to plain text with values intact.

A reference column **always stores as text** — the engine maps `reference →
select` at every storage / read / filter boundary via `storageType()`. (An
earlier cut of v2.2 explored per-column reference *modes* — a checkbox variant
and a deferred multi — but they were removed before release: the checkbox mode
was flaky and the mode machinery widened the type surface for no user-visible
gain. A linked column now has exactly one behavior.)

**Deploy: tag-only bump — no migration, no compose change.**

## v0.136.0 — 2026-07-15

**Tables: reference columns from the grid + Excel-style cell expand.** Two UI
follow-ups to v2.1's reference columns, both grid-only (no engine/schema
change). (1) A **"Link to another tab…"** item in the column-header menu opens
a dialog to pick a source tab + column and turn the column into a cross-tab
reference — the shipped validation / draft-op / `ReferenceCell` pipeline does
the rest, so references are now creatable without the assistant. Retyping away
from reference clears the link. (2) Long **text/url cells** get an expander (⌘↵
save, Esc cancel): because the grid virtualizes on a fixed row height, the full
value opens in a portal popover instead of growing the row — no reflow, no
virtualization fight. Shipped after a 2-reviewer adversarial audit; fixes in
the same release (Esc-cancel now truly cancels; re-pointing a reference
refreshes its dropdown; a rejected op no longer wedges autosave).

**Deploy: tag-only bump — no migration, no compose change.**

## v0.135.0 — 2026-07-15

**Tables v2.1: multi-tab workbooks + cross-tab reference columns.** One Table
is now one SQLite workbook of N tabs (the Excel model): a tab bar switches
sheets, spreadsheet imports land every sheet as a tab of one node (the
sheet→tab flip — no more sibling tables), and a bare single-tab doc stays
byte-compatible with v2. New **reference columns** (`type: 'reference'`) offer
values from another tab's column, Excel data-validation style — soft integrity
(free text allowed, dangling values flagged in the profile, degrade-to-text
with values intact when a source is removed). An embedded **schema layer**
(data dictionary + join edges) backs `table_sql` and rides the corpus map as a
`schemaDigest`. The grid autosaves as **op batches** (`diffTableDocs` → the
`draft_rev` etag), scaling edits past the 10k window; reference cells get a
lazy typeahead editor (`?distinct=` on the rows route).

Shipped after a 3-reviewer adversarial audit; every confirmed finding fixed in
the same release. Notable fixes: formula↔stored column retypes are now DDL (a
retype used to leave the file unreadable); new-row runs and top-of-grid inserts
persist in the right order (op round-trip is now `applyOps(X, diff(X,Y)) === Y`);
autosave no longer drops edits typed during an in-flight save; the whole-doc
guards and truncation caps are draft-aware; `PUT /draft` carries the `if_rev`
etag; and file-replacing renames sweep stale `-wal` sidecars first. The
`draft-ops` route is now validated with a strict per-op schema.

**Deploy: tag-only bump — no migration, no compose change.** The `table-dbs`
mount and migration 0120 shipped with v0.134.0; v2.1 is code-only. Skill
bodies (`table_authoring`, `tool_grounding`) force-sync on the version bump.

## v0.134.0 — 2026-07-15

**Tables v2: sqlite-native table storage.** Each Table node now lives in its
own SQLite workbook file (`TABLE_DB_DIR`), with the Postgres registry row as
the lock spine (migration 0120, additive). Highlights: read-only `table_sql`
with a worker-thread watchdog; profile-only indexing (rows are never embedded
— schema/profile chunks + FTS trigram shadows replace row dumps); draft-op
batches with a `draft_rev` etag and WAL-safe commit-promote (VACUUM INTO +
atomic rename); windowed reads past the 10k materialize cap; `.sqlite` export;
part-splitting retired (2M-row explicit ceiling); lazy migration of legacy
JSONB tables plus a background sweep. JSONB dual-write is kept as the rollback
lever; blob retirement (`retire-table-blobs.ts`) lands next release.

**⚠️ Deploy note — compose refresh REQUIRED, a tag-only bump is not enough.**
This release adds the `table-dbs` volume mount (`TABLE_DB_DIR=/data/table-dbs`)
to the web and worker services. Refresh `docker-compose.yml` on every box
before `compose pull`, or table storage lands inside the container filesystem
and is lost on recreate. `db-dump.sh` and the scheduled backup now snapshot
the workbook files (VACUUM INTO) alongside pg_dump.

## v0.133.2 — 2026-07-15

**Hotfix 2: migration 0119's journal `when` predated 0118's**, and the
migrator gates on `when` > max recorded `created_at` — so boxes that already
ran 0118 skipped 0119 even with the journal entry present. Restamped to the
+1-day ledger convention; the journal guard test now also enforces strictly
increasing `when` values.

## v0.133.1 — 2026-07-15

**Hotfix: migration 0119 was missing its journal entry**, so the migrate gate
skipped it ("Already up to date") while v0.133.0's code queried the new
`content_chunks.search_tsv` column. Journal entry added; a new guard test
fails the suite whenever a migration .sql lacks a journal entry (or vice
versa). Boxes that rolled v0.133.0 self-heal on this release — the migration
SQL is idempotent.

## v0.133.0 — 2026-07-15

**Retrieval: hybrid passage search, spreadsheet profiles, corpus map.** Born
from a production recall audit. (1) `search_chunks` gains a keyword arm —
weighted RRF over the new `content_chunks` tsvector (migration 0119) with a
rescue floor, so exact rare tokens (error codes, field names, coined terms)
are findable even when they embed poorly; the responder's auto-context uses
it too. (2) Spreadsheets index as one profile chunk per sheet (headers +
sampled rows + honest coverage note) instead of thousands of embedded grid
rows — they were 74% of one brain's chunk table; full text still persists for
`file_read`. Versioned exports (date/`_version_NN` families) get their older
copies salience-down-ranked, newest self-heals. (3) Every responder turn now
carries a cached corpus map — branch-grouped titles (+ page/table one-liners)
on its own prompt-cache breakpoint, `memory_config.corpus_map_limit` to tune.

## v0.120.1 — 2026-07-07

**Duplicate block ids fixed + self-healing.** The page editor could mint two
blocks with one id (Enter-split copied the id; copy-paste re-imported it),
which made every later twin invisible to the block-level edit tools —
`page_block_get`/`update`/`delete` resolve the first match, so targeted
edits could land on the wrong block. The editor now re-mints ids on split
and paste (a new `appendTransaction` plugin in the `BlockId` extension keeps
the doc unique-id by construction), and server-side `ensureBlockIds` re-mints
any duplicate on read or save — first occurrence keeps its id, so held
addresses stay valid and already-corrupted docs/drafts repair themselves on
next touch, no migration. Also fixes `replaceBlock` id inheritance (the
"first new block keeps the target's id" contract was dead in production
because `markdownToDoc` mints ids at parse — every block update silently
churned the target's id).

## v0.120.0 — 2026-07-07

**Team Hub.** `/team` lands on a briefing hub — hero, curated briefing
cards, live brain stats, and Team Chat one tap away. Curation is just
sharing: the new **Team members only** toggle on a Page share puts it on the
hub; team-mode links now work for every content kind with automatic member
recognition from the hub. Full notes: `docs/_changelog/0.120.0.md`.

## v0.119.1 — 2026-07-07

**See what the validator sees.** v0.119.0's argument validation ships in
warn mode — recording what it *would* correct while changing nothing. The
new **`/debug` → Tool validation** tab makes that telemetry readable without
SQL: the box's active mode (with what it means and how to flip it), flagged
calls per tool over a selectable window (repairs / unknown keys /
violations, violations highlighted), and each recent flagged call in full
detail — violation texts, did-you-mean suggestions, repair notes — linked to
its trace. Violations are the enforce-flip question; a cluster on one tool
usually means a schema bug to fix first. Clean calls write no telemetry, and
the page says so, so an empty tab means "nothing flagged", not "no data".

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

**Big page edits no longer die halfway.** A large SOP restructure on a production brain
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
label — e.g. "Refinery" — so when you run several brains it's obvious at a
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
plain-HTTP field install. HTTPS remains strongly recommended — see
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
