# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the `linux/amd64` image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## Unreleased: team apps Phase 3, members build apps

A team member builds mini apps like Pages (plan page b6dd688e, section A).

- `my_app_*` tools on a member's own MCP: create, write files, build,
  publish, schema, tools, snapshots, errors, share, submit, recall. Reads
  always; changes with the Write switch. Never a client's.
- The app lives in the member's personal space: private, then shared with
  the team (every member runs and writes it), then submitted (frozen) for
  an admin to accept into the brain at admin or team level, or return.
- The author ceiling (migration 0235, `apps.author_level`): a member's app
  runs its tools at team rules at most, an admin's run included, unless an
  admin accepts it with its tools reviewed.
- Member routes: `GET /api/member/my-apps`, `POST .../:id/share`,
  `.../submit`, `.../recall`, `GET .../:id/history`. The member run routes
  (frame, db and tool brokers) run a member's own or team-shared app, keyed
  to the author's space.
- Admin routes: `GET /api/team-admin/app-submissions`, `GET .../:id` (the
  published source), `POST .../:id/accept { level, trustTools }`,
  `POST .../:id/return { note }`.
- The space purge never deletes a member's app.
- M3 audit: Accept is pinned to the reviewed version and a hash of its
  source, manifest and build (409 `changed` otherwise, or with a draft
  pending). A copy keeps the source's author ceiling, an import starts at
  team, a member-era undelete or code restore comes back at team; only
  `PATCH /api/apps/:id { trustTools }` lifts it. A member's change holds
  the app's state row, so it never races a Submit or an Accept. The list
  pill and the run lookup share one read-only rule. The roll's connector
  check runs only on the roll that crosses into connectors by level.
- Every app list carries `dataAccess` ('read' or 'read_write') for the R
  and R/W pill, and the sidebar carries `mcpAccess`.

## Unreleased: team apps Phase 2, connectors by level

An MCP connector's level now decides who may use its tools, as the level on
an item does (plan page b6dd688e, section C).

- Apps below admin: a member's run reaches a connector at team, client or
  public level, a client app one at client level, a contact link one at
  public level. This replaces External access for connector tools; single
  http tools keep External access.
- The admin's confirm on a connector tool is its read-only mark: marked =
  read, unmarked = write. Apps may write through an unmarked tool (Jason's
  decision); the member, client and contact brokers log every write call
  with its input (2 KB).
- Members' and clients' own MCP lists the connector tools at their level;
  write tools only with the Write switch. Every call is in the audit log.
  The member Settings > MCP lists the connectors open to them.
- The connector list carries its level.
- `pnpm -C server/web connector-levels`: a read-only count, before a roll,
  of the apps that lose or gain a connector tool and the connectors below
  admin (ids and numbers only). Nothing raises a level by itself.
- An undo snapshot whose row fails to commit no longer leaves its file.
- Contacts read only (Jason): a public run (contact link, public agent)
  only calls connector tools marked read-only.
- `dispatchMcp` holds the connector level and the public read-only rule on
  every non-owner call, whatever group listed the tool.
- A changed or moved connector voids the mark (refused below the owner
  until marked again); a connector moved while below admin disables its
  unmarked tools, and new remote tools arrive disabled there.
- `scripts/roll.sh` stops a roll that would open connector write tools
  (numbers only) unless `--ack-connector-writes`.
- Admin texts (api_tool_update, app_tools_set, app warnings) say that
  unmarking makes a connector tool a write, never closes it.

## Unreleased: team apps Phase 1, MCP on app data

Members and clients reach the data of mini apps from their own MCP client
(plan page b6dd688e). Migration 0234.

- New per-app switch **MCP access** (`apps.mcp_access`, off by default),
  set only by an admin with `PATCH /api/apps/:id { mcpAccess }`.
- New login MCP tools `app_data_list`, `app_data_schema`, `app_data_query`
  and `app_data_write`. They replace `app_db_list` / `app_db_query` on a
  member's or client's MCP. Reach and the read or write rule are the
  browser's; the login's Write switch adds `app_data_write`.
- Rows only: a data-only engine authorizer in the SQL child refuses every
  schema change on an MCP write.
- The first MCP write to an app in an hour takes a `pre_mcp_write` snapshot
  first; no snapshot, no write. Every MCP call lands an access log row;
  a write keeps its SQL and the rows it changed.
- `pre_mcp_write` snapshots are pruned on their own line: the newest 24 per
  app within `APP_SNAPSHOT_MCP_MAX_MB` (default 512), so they never push out
  the other automatic snapshots.
- A peer bound to a member or client now acts under that login's switches:
  the login's MCP switch off refuses the peer, and it writes only while the
  login's Write is on too.
- New API key area `app_data`.
- Members get their own view of Settings > MCP: `GET /api/member/mcp` and
  `DELETE /api/member/mcp/clients/:id` (their own grants only).

## Unreleased: Apache Tika 4

The document helper moves from `apache/tika:3.3.1.0` to `apache/tika:4.1.0-1`
(Java 17+, process-isolated parsing). The roll needs nothing by hand: the
compose file carries the new image and an inline JSON config.

- Text comes from `PUT /tika/text` (and `/tika/html` for the legacy `.xls`
  conversion). Tika 4 ignores `Accept`, and its bare `/tika` returns
  Markdown. Against a Tika 3 server the client asks again the 3.x way, so a
  box whose Tika container has not rolled keeps parsing.
- Tika 4 parses in a fixed pool of forked JVMs. The config sets one fork with
  a 1 GB heap, a 60 s parse timeout (the 4.x default is one hour) and only the
  endpoints Mantle calls. A document that arrives while the fork is busy gets
  a 429, which the client now waits out instead of indexing nothing.
- `/unpack/all` has a new ZIP layout (numbered entries with metadata
  sidecars, plus the container itself). Embedded images from legacy formats
  read both layouts.
- The container cap rises from 1.5 GB to 2 GB. Measured: idle about 250 MB
  (3.x about 230 MB), peak about 1.2 GB on a 43 MB HTML file (3.x about
  0.5 GB). The image is 190 MB compressed (3.x 178 MB).
- PowerPoint text is now read in-process (`parsePptx`, parse route `pptx`).
  Tika 4 orders slides by relationship id as a string, so any deck past nine
  slides came back shuffled (4.0.0, 4.1.0 and the 4.2.0 snapshot alike).
  Tika stays the fallback for a deck the reader cannot open.

## Unreleased: the fresh-install look

A FRESH install now wears the Jackdaw colour theme, Lorelei avatars and the
Neat background (switched on, seed 55361, tone auto, speed 2). One source,
`FRESH_APPEARANCE` in client-types (zero dependencies, so the brain and the
clients read the same object): a new profile row stores it, the brain's
read fills it in for a row that never set a value, `/api/appearance` serves
it before the first account exists, and share-ui's client fallbacks
(`resolveAppearanceAttrs`, `DEFAULT_AVATAR_STYLE`) use it.

An EXISTING brain keeps the look it shows today. Migration
`keep_existing_look` writes the old effective values into every existing
profile row that has none of its own: `colorTheme` `clean-slate`,
`avatarStyle` `thumbs`, `neatBackground` `''` (off). Absent, JSON null and
(theme and style only) blank values are filled; a present value is never
touched. A fresh install has no profile rows when migrations run, so it is
untouched. A stored theme the registry no longer knows still paints the
baseline, as before.

share-ui now names the CSS baseline `BASE_COLOR_THEME` (still `clean-slate`,
the theme painted with no `data-color-theme` attribute);
`DEFAULT_COLOR_THEME` is a deprecated alias of it with the same value, and
`FRESH_COLOR_THEME` is the new default.

## Unreleased: needle scrollbars everywhere

Every scrollbar in the share surfaces, the mini-app frame and the Jackdaw
client is now one global needle (share-ui `app.css`): a 4px thumb in the
theme's primary colour, 6px under the pointer, on a transparent track. No
class is needed; `scrollbar-hidden` (or Tailwind's `scrollbar-none`) still
hides a bar. The fat grey bar came from Tailwind 4's own `scrollbar-thin`
utility: it sets `scrollbar-width: thin`, which in Chromium switches the
styled bar off, so Chrome drew its 11px platform bar on every
`.scrollbar-thin` pane. Measured: 11px and 15px before, 6px after, in Chrome
and Safari. Firefox draws its own thin bar in the theme colour.

## Unreleased: API keys and the public HTTP API v1

Scripts and MCP clients get real API keys (migration 0232, plan page
1e62e204). Each login makes its own keys in **Settings > API access**
(members from their menu, clients under **API keys** in the portal). A key
acts as the login that made it and can only narrow it: read only or read
and write, all areas or some. Nobody can make a key for another login.

- **Where a key works:** `Authorization: Bearer mtlk_...` on `/api/mcp` and
  on the new versioned `/api/v1` (31 routes: whoami, search, pages, notes,
  tasks, tables, files, events, contacts, journal). Every other route
  refuses a key. Breaking changes go to `/api/v2`; v1 stays six months
  after.
- **Safety:** only a SHA-256 of the key is stored, compared in constant
  time; the key is shown once. Admins and members re-type their password
  to make one; member keys last at most 90 days, client keys 30. A password
  change, Sign out everywhere, or an admin's End sessions, disable or role
  change revokes the login's keys. A key never confirms a visibility change,
  cannot make a page public, and cannot change the content of an item others
  can read. Every write a key makes is audited with
  the key id and its maker (`key.created`, `key.revoked`, `key.refused`,
  `api.write`).
- **Told when a key is made:** the login gets a notice (members and
  clients in their own thread, pushed to their phone; admins a push to
  their own devices). It names the key, its access and expiry, never the
  secret.
- **OAuth connectors now end with the login's security actions:** a password
  change, Sign out everywhere, an admin's End sessions, disable or role
  change, and a reused device token revoke the login's OAuth grants, an
  admin's included (they used to survive). Reconnect the connector after a
  password change. Admins and members now type their password at the
  connector's consent page.
- **Client keys** end when the client signs out (a client has no password to
  re-type).
- **Limits:** 120 requests a minute per key on v1 and 300 on MCP, 600 and
  1200 per login across its keys, search 30 a minute per key, 50 live keys
  per login, 20 failed tries a minute per address and key prefix and 100
  per address.
- **MCP tokens retired:** an admin no longer makes `mtlmcpk_` tokens for a
  member or client (`POST /api/mcp-logins/:id/tokens` answers 410). Tokens
  made before keep working until revoked, and Settings > MCP still lists
  and revokes them. Members and clients make their own key instead.
- Docs: docs/guide/07-api/08-api-keys.md (new), 03-http-api.md
  (rewritten), 02-mcp-login.md.

## 0.239.13: the Mantle logo files are back in brand/

The Mantle marks left this repo with the jackdaw split and were later
deleted from jackdaw too, so no repo held a canonical copy. `brand/` holds
them again, restored unchanged from git history, with the Affinity design
source (`brand/mantle-logo-design.af`) they were exported from.
`brand/README.md` names the source and records where the files went.

## 0.239.10: the service switches live at Settings > Services

The sandbox and media switches moved off the dashboard to their own screen,
`/settings/services` (shared nav, Power icon, a help topic). The sandbox and
media refusals and the docs point there. docs/services.md.

## 0.239.9: app builds accept type-only imports

`lintRuntimeImports` read `import type { ReactNode } from 'react'` as a value
import (and `{ type X }` as a name `type X`), so an app with type-only
imports failed to build. Type-only clauses and specifiers are skipped now; a
mixed import still checks its value names.

## 0.239.4: a service switch's .env backups belong to the stack owner

`backups/env` was made by the root sidecar with umask 077, so the box owner
could not read their own `.env` backups without sudo. The directories now
go to the stack directory's owner, as the pre-roll backup's do.

## 0.239.3: switch sandboxes or media on and off through the updater

- **The updater** takes one new request kind, in its own file
  (`/signal/service-request.json`, so an older updater never takes it for a
  roll): a service (`sandboxes` or `media`) and on or off.
- **On:** a free-disk check, `.env` backed up to `backups/env` (newest 5),
  the token and sandboxes directory written when missing, the profile
  added, only that service pulled and started (`--no-deps`), then a health
  wait. Any failure restores `.env` and stops the container again.
- **Off:** running sandbox containers are stopped (never removed), the
  service container is stopped and removed, the profile dropped. Tokens,
  the sandboxes directory, every sandbox's files, app data and images stay.
- **Routes** (admin logins): `GET /api/services` (state, plain descriptions
  with download size and memory, the small-box warning, the current run),
  `GET /api/services/status` (progress), `POST /api/services/:name
  { enable }`, audited as `service.toggle`. A switch is refused while a roll
  runs, and a roll while a switch runs. The brain offers the switch only
  when the updater advertises the verb.
- docs/services.md (new); sandboxes.md, video-ingest.md and self-hosting.md
  point at it.

## 0.239.2: outside Claude learns how a mini app knows who runs it

An MCP client building an app had no way to learn about `host.me()`; only
the in-brain `app_authoring` skill taught it.

- **`app_create`** carries a short runtime hint: `host.me()`, the
  `:host_me_*` parameters with a SQL example, `host.db`, `host.tools.call`
  with `app_tools_set`, and the level rules. `app_file_write` and
  `app_source_set` point at it; `app_tools_set`, `app_db_schema_set` and
  `app_db_query` say the rules that touch them.
- **`app_authoring_guide`** (new, MCP only, read only) serves
  docs/app-authoring-guide.md whole or one section. The admin server
  instructions point at it.
- **Docs drift fixed:** the guide said a team app cannot learn the member,
  and that share links and members never call outside tools (External
  access says otherwise). The Appsmith skill states the current levels.

## 0.239.1: the boot reconcile keeps the owner's param switches

`syncSpecialistDefs` wrote the manifest `params` whole onto every enabled
specialist, so a `tool_loading`, `suggest_follow_up` or `top_p` the owner
set went back to the manifest on the next boot. Those three keys
(`OWNER_PARAM_KEYS`) now keep their stored value; the manifest still owns
`temperature` and `max_tokens`. Adopt from template follows the same rule.
The compare ignores jsonb key order, so a row is no longer rewritten on
order alone. The propagation table in
`server/web/lib/system-manifest/CLAUDE.md` names the kept keys.

## 0.239.0: one live source for whether sandboxes and media are on

- **`serviceEnabled()`** (@mantle/config) answers for the dashboard pills,
  `/api/sandboxes`, the sandbox tools, `video_ingest`, the CAD render path
  and the agent tool list, instead of a check for a bearer token. On means
  the compose profile is active (the updater's live
  `/signal/services.json`, else the container's `COMPOSE_PROFILES`) and the
  URL and token are set.
- **A service that is off shows a grey pill**, not red.
- **An agent is not offered** `sandbox_*` or `video_ingest` where the
  service is off (`effectiveToolSlugs` drops them; the grant stays).
- **The updater** writes `/signal/services.json` (profiles, token presence,
  container state, host memory, disk, core shape, verbs) with `stack.json`.
  Every app service mounts `/signal` read only.
- **Both service tokens** are made on a roll and on install, so a later
  switch starts one container instead of restarting the brain. Never
  rotated.

## 0.238.18: memory_config saves, and the oauth2 binding survives the editor

- **One `memory_config` schema.** The agent POST and PATCH routes held two
  copies that had drifted (a create with `chunk_limit`, `corpus_map_*` or
  the Journal keys was a 400). Both use
  `lib/agent-memory-config-schema.ts`. A key sent as `null` is now removed,
  so a field cleared in the form goes back to its default.
  `AgentMemoryConfigDTO` gains `corpus_map_limit`, `corpus_map_chars`,
  `max_tool_calls` and `max_calls_per_tool`.
- **The tool-group editor** has no `oauth2` field, and a save from it
  dropped the stored client-credentials binding. An absent `oauth2` now
  keeps the stored one; `oauth2: null` still clears it.

## 0.238.17: the corpus map in about 2k tokens, every branch shown

The "what exists" block rendered up to 24k characters (about 7.6k tokens a
turn) and filled its budget alphabetically, so on a big brain `tables` and
`tasks` never appeared. The prompt-block audit of 2026-10-05 found no
answer-quality gain from the block at that size.

- Budget 6,500 characters by default (`memory_config.corpus_map_chars` per
  agent), shared round robin across branches, newest items first.
- Branch headers carry the corpus-wide count. Three or more file titles
  that differ only in digits fold into one line; other types fold only on
  an exact duplicate, so dated titles keep their own line.
- Page summaries are left out; tables keep their schema digest. The block
  claims to be complete only when it is. docs/memory.md.

## 0.238.16: the deferred tool catalog lists groups no flow holds

Under `params.tool_loading = 'deferred'`, a group no flow holds (an owner's
API integration, an MCP or OpenAPI connector) gets its own catalog line,
and `tool_search` takes that group slug as its flow. A tool's first
description sentence reaches the catalog only when the brain wrote it
(builtins and owner-written http tools); MCP tools, OpenAPI-compiled tools
and recipes stay names only. The search rule wording is unchanged (a
stricter one lost on the bench). docs/tools-and-skills.md.

## 0.238.15: the delegate roster shrinks lines instead of dropping delegates

Over its 1,200-character budget the roster dropped delegates from the end of
`delegate_to`, so a parent with many specialists never delegated to the
hidden ones. Every delegate now stays: lines shrink lowest rank first, to one
group chunk and then to the bare name. The tail is cut (and the cut said)
only when even the bare names overflow.

## 0.238.14: http tools fill omitted inputs from their schema defaults

An optional `{param}` the caller left out dropped its query pair, so a
paging field with `default: 50` sent an unpaged request. The dispatcher now
fills absent top-level fields from the tool's `input_schema` defaults before
templating. A field that is present (even `null`) is left alone.

## 0.238.13: OAuth2 client credentials for integration groups

- An integration group can carry `oauth2`: a token URL and vault refs for
  the client id and secret. Tool templates place the token with
  `{{oauth:<group-slug>}}`; `tool_group_ensure` defaults the placement to a
  Bearer `Authorization` header.
- At call time the dispatcher trades the credentials for a token through
  `safeFetch` (the same egress rules as every api-tool call), keeps it in
  process memory until shortly before it expires, fetches one at a time per
  group, and on a 401 replaces the token once and retries once. The token
  goes only to the group's `base_url` origin; the token, client id and
  secret are scrubbed from every result and error.
- **Fix:** `tool_group_ensure` no longer drops a re-declared `base_url`,
  `secret_ref` or `auth_template` on an existing group.

## 0.238.12: client code caps end at now

The client code send caps counted codes created after "now minus the
window" with no upper end, so codes stamped in the future (a test fixture)
counted against every real request. The caps and
`clientCodesSentLast24h` count only the window before now. No change on a
live box.

## 0.238.9: New chat, Previous chats

"New chat" (web) and `/new` (Telegram) close the agent's open chat and start
a fresh one. The old chat stays saved and searchable under Previous chats.
docs/conversation.md section 6c.

- **Migration 0231** (`0231_chat_threads`): `chat_threads`, one row per
  thread, a time range over the agent's `assistant_messages`. Messages never
  move. No row means the old single thread.
- **What a turn reads:** the history window, digests, history recall and the
  follow-up enrichment read only the open thread.
- **The archive summary:** one summarizer call per archive writes one note
  (`data.kind: chat_archive`, embedded, never extracted). It comes back by
  relevance and in `find_window` (kind `thread`). No trigger or timer runs
  it; a failed call leaves a plain title and a retry route. A closed range
  is digested alone, so no digest spans the cut.
- **Continue from this** seeds the new chat with the archived thread's
  summary, writing the summary first when it is missing.
- **Routes:** `GET/POST /api/assistant/threads`, `GET
  /api/assistant/threads/:id`, `POST …/:id/continue` and `…/:id/summarize`.
  `/thread` and `/messages` answer the open thread only
  (`messages?thread=<id>` pages an archived one).
- Deleting an agent removes its archive notes with the digests.

## 0.238.8: the reflector skips MCP-answered turns

A turn an MCP client answered as the agent (`responder_turn_record`, channel
`mcp`) neither wakes the reflector nor reaches what it reads, so persona
notes never learn from a test model. The summarizer still reads these turns
into digests. docs/connecting-claude.md.

## 0.238.7: deferred tool loading (opt in per agent)

An agent with `params.tool_loading = 'deferred'` is sent a fixed core of its
granted tools plus `tool_search` and `use_tool`. Every other granted tool is
listed by name in a catalog in the first (cached) system block.
`tool_search` ranks the deferred tools in code (BM25 over tool cards,
synonyms, a usage prior) and returns their full schemas; the model calls a
loaded tool by name or through `use_tool`, and both dispatch, validate,
guard and trace as the real tool. An ungranted name is still refused. The
tools sent depend only on the grant, so the cached prefix does not move.
Absent or `'full'` keeps the old behaviour.

- The core goes out in a fixed list order (search and read first).
  `update_persona` is in the core.
- A deferred tool called by name with bad arguments gets its real input
  schema back, once per turn.
- Bench (101 cases, right first tool): about 11k instead of 58.5k tool
  tokens per call; Claude scored 88 to 90 against 91 with the full list.
- docs/tools-and-skills.md, "Deferred tool loading".

## 0.238.6: responder_turn_record

Opt-in write after `responder_turn_input`: the user's message and the MCP
client's reply land in the agent's conversation (channel `mcp`), so the
Assistant window, the history window, digests and replay see them. The
reply's model is the client's; `data.authored_by` names the client and
model, and a trace (`mcp_turn_record`) names who answered. Owner connector
only; team and client responders are refused. A channel `mcp` reply sends no
push. `replay_window`'s app arm now reads web, mobile and mcp turns (it read
web only, so mobile turns were missing too). No new trigger or cron.
docs/connecting-claude.md, docs/conversation.md.

## 0.238.5: box-maintain containers see the file bytes

`box-maintain.sh` containers now mount the `mantle_web` volumes read only.
Without `/data/files`, `ocr-rescan` counted every PDF as unreadable.

## 0.238.4: responder_turn_input

`responder_turn_input` (MCP, owner surface) returns one responder turn's
exact input up to the model call, with no model call: the composed prompt,
the retrieval for the message, the history and the tool list. An MCP client
can answer as the agent with its own model and see what the agent saw. It
shares the sim's read path. Tools default to name and first sentence;
`schemas_for` fetches full schemas. A peer needs it named; team and client
responders are refused. The sim's caller history is now cut to the agent's
history window and drives the follow-up enrichment. docs/connecting-claude.md.

## 0.238.3: ocr-rescan for scans indexed wrong

Before 0.238.2 a scanned PDF of two or more pages was indexed as its own
page markers, and a one-page scan stuck at `body_too_short`. `pnpm maintain
ocr-rescan` (dry run by default) prints counts, pages, the models that will
run and an estimated cost from the live catalog. `--apply` clears the bad
text, summary, embedding and chunks and re-queues each file through the
normal extract queue in batches; `--limit=N` to start small. Ids and counts
only.

## 0.238.2: extract skips are stamped, and scans OCR again

- **A node the extractor reads and finds nothing in** (no parser, body too
  short, media, encrypted PDF, missing bytes, a digest, an empty Telegram
  turn) kept no embedding, so the boot drain and every provider recovery
  queued it again. Such skips now stamp `data.extract_skipped = { reason, at
  }`, and the drain leaves the node alone while the stamp is newer than its
  `updated_at`. An edit makes the stamp stale; a successful pass removes
  it. `pnpm maintain extract-skip-stamp` (dry run; `--apply`) stamps the old
  loops in plain SQL.
- **`parsePdf`** returned pdf-parse's `-- N of M --` page markers for a PDF
  with no text layer. Markers alone now parse to an empty string, and the
  scan takes the OCR path.

## 0.238.0: provider outages are visible and recover without a restart

An embedding account with no credits answered 429, every extract job
dead-lettered for days, chat turns lost their context, and nobody was told.
Fixing the account did not move the backlog until a restart.

- **Error classes** (`provider-error.ts`): account errors (no credits,
  refused key, no key, unknown model) apart from transient ones. A
  no-credits 429 no longer waits through the rate-limit backoff. Embedding
  and chat failover also fail over on an account error.
- **Migration 0230** (`0230_provider_alerts`): `provider_alerts`, one row per
  brain and subject, fixed reasons only. Every embed and extractor chat call
  reports its outcome; a call that works closes the alert. Admins see it in
  Needs you, the live stream and one phone push.
- **The circuit** (`provider-circuit.ts`): a confirmed account error pauses
  the extract queue and probes at 5, 10, 20, 40 minutes, then hourly. When a
  probe works the queue resumes, dead letters are re-driven and unextracted
  nodes swept, with no restart. A settings save or **Try again** (`POST
  /api/embedding/recover`) probes at once. The boot line says PAUSED while
  the circuit holds the queue.
- **Same-model backup:** Settings suggests OpenRouter for OpenAI direct and
  the reverse; onboarding sets it when the key is saved. The OpenAI adapter
  drops an `openai/` prefix, so one slug serves both routes.

## 0.237.13: box-maintain.sh, and a bounded chunk-windows backfill

- **`scripts/box-maintain.sh <box> <task> [args]`** runs a long `pnpm
  maintain` task in a throwaway sibling of `mantle_web` (same image and
  network, the web env through a pipe, its own memory limit, `--rm`, a
  mode-600 log file). It refuses a second run on the box. `--status`,
  `--logs`, `--follow`, `--stop`. `pnpm maintain` now always ends with one
  line: finished, FAILED with the exit code, or killed by a signal.
  docs/maintenance-runner.md, update-prod.md.
- **The chunk-windows backfill** held a page of 500 chunks as JS arrays and
  one big JSON parameter, and was killed at `--parallel=16`. It now reads
  chunks as text, copies a one-window chunk in SQL, and writes the others in
  batches of about 100 windows. Measured peak memory at `--parallel=16`:
  1,047 MB down to 486 MB.

## 0.237.11: one shared connection pool for every provider call

Node 26.5's built-in fetch sends POSTs one at a time on a warm HTTP/2
session, so N parallel provider calls took N request times. `providerFetch`
(`packages/voice/src/adapters/provider-fetch.ts`) is the built-in fetch with
one shared undici Agent (HTTP/1.1 keep-alive, 32 connections per origin).
Every voice adapter, the OpenRouter client and the decisions judge use it;
32 parallel POSTs went from 9.9 s to 0.24 s. The tailnet proxy loads undici
the same way (its bare `require` threw under ESM). Embed calls back off on a
429 (2, 4, 8, 16 s). The windows backfill takes `--parallel=N`.
docs/provider-http.md (new).

## 0.237.10: passage windows, a deeper judge pool, a parallel judge

- **Passage windows** (opt in): each chunk also gets about 800-character
  sentence windows with their own vectors, and passage search adds a window
  arm that returns the window's chunk, so the prompt budget does not change.
  **Migration 0229** (`0229_chunk_windows`): `embedding_config.chunk_windows`
  (default false) and `content_chunk_windows` (no text, HNSW halfvec, RLS
  follows the node). `pnpm maintain chunk-windows` (dry run, `--apply`,
  `--off`, `--clear`) and `eval:route --windows`. On the library test
  corpus, paraphrased questions R@10 rose from 40% to 63%.
  docs/embeddings.md.
- **`passage_scoring.pool`** goes up to 200 (was 100); with windows on the
  pool doubles.
- **The judge fan-out runs side by side** (it ran one request after another
  under the built-in fetch). Pool 50: p50 1.39 s to 0.91 s.
- docs/recall-eval.md, docs/decisions.md.

## 0.237.7: a keyword-found passage skips the cosine cutoff

The 0.65 cosine cutoff threw away literal matches that embed poorly (a code,
a reference, a coined word) even when the keyword arm ranked them first.
Under `KEYWORD_PASSAGE_RULE = 'exempt'` a passage with a keyword-arm rank is
not held to the cutoff; its place and the `chunk_limit` cut are unchanged.
The trace says `exempt:keyword`. Gated with `eval:route`.
docs/recall-eval.md.

## 0.237.6: the context decision trace, and eval:route

- **Decision trace v1:** every turn's `load_context` snapshot carries
  `trace` (`ContextTrace` in @mantle/client-types): per stage the candidates
  in, kept, dropped and milliseconds; per candidate the block, key, the
  stage and reason code, which arm found it with its ranks, the distances
  and the judge score. The `search_chunks` step output carries the same
  trace. Observation only: the prompt is unchanged. Ids and codes, no text,
  150 rows at most. docs/observability.md.
- **`pnpm -C server/web eval:route`** runs a typed case set through named
  rulesets and reports R@1, R@10, MRR, latency and cost per question type,
  with a paired gate against the reference. Manual only; prints its cost.
- **Fix:** `recall_eval`'s `chunks` line measured the vector arm alone; it
  is now the hybrid path agents use (`chunksVector` keeps the old number).
  docs/recall-eval.md.

## 0.237.4: an optional deeper pool for passage_scoring

`uses.passage_scoring.pool` (per brain; unset keeps the old pool) sets how
many passages to fetch and score, up to 100, fanned out in requests of 25.
With a pool set, auto-context scores before its budget cut even when
`context_pruning` is on. `eval:recall` gains `passage-scored`. On the
library test set, a pool of 50 lifted `search_chunks` R@10 from 43% to 53%
at about three times the judge cost. docs/decisions.md.

## 0.237.3: the keyword arm speaks only on rare literals

On a large single-topic corpus the hybrid passage search scored below
vector only: a question's frame words outvoted its one rare word. The k-th
rarest term now weighs `idf * 0.5^k`, question-frame words are dropped like
chat filler, and the passage keyword arm returns rows only when they hold a
rare term (`gateRareTerms`). Passage search p50 went from 150 ms to 14 ms.
Node search is unchanged.

## 0.237.1: per-agent thinking effort

- **Migration 0228** (`0228_agent_thinking_effort`): `agents.thinking_effort`,
  nullable. NULL inherits the person's profile setting, as before; `off`
  never reasons; a tier is that effort whatever the profile says.
- One rule (`resolveAgentThinking` in content-core) for every turn path:
  web, Telegram, sim and resumed runs, team and client turns, delegated
  agents, heartbeats and run workers.
- Read and set through `GET/POST/PATCH /api/agents`, Agent Studio, and
  `agent_set_thinking_effort` (new; no self-change, an agent asking waits
  at /pending). Shipped agents stay on inherit. docs/thinking.md.

## 0.237.0: passage-level recall eval, and the measured capacity policy

- **`eval:recall`** gains passage retrievers scored on the exact chunk and
  on the document (`passage`, `passage-vector`, `passage-keyword`). Cases may
  name `expectChunks` and a group; `--retrievers` picks a subset.
- **`corpusCapacity`** (the dashboard dial and `brain_capacity`) also
  returns `retrieval`: the passage recall@10 and MRR of the newest
  `recall_eval` run, or null. Optional on `BrainCapacity`.
- **Passage-vector policy:** watch at 100k and split at 250k (was 50k and
  100k), from a measured scale curve: recall@10 falls about 6 points per
  doubling, with no cliff. docs/recall-eval.md, "Scale curve".

## 0.236.1: foldable headings in pages

A heading can fold: `## Title {fold}` (open) or `{fold=closed}`. Fold state
is the reader's own, kept in localStorage per heading block; print shows
every section. The share reader, the page renderer and `page_blocks_list`
(`meta.fold`) know it. Docs without the marker are unchanged.
docs/pages.md, docs/rich-writing.md.

## 0.236.0: MCP as a login

`/api/mcp` now serves any login. docs/mcp-as-a-login.md.

- An admin's OAuth grant keeps the full owner surface. A member's or
  client's grant (or a static login token) gets that role's responder tools
  at the login's level, read only unless an admin turns write on, and then
  only the draft tools of the login's own space. A login with no tools gets
  a plain 403.
- A peer token can act as one login (owner, member or client) with its own
  write switch. Bound to the owner it gets the owner surface without the
  risky tools (runs, mail, the contacts allowlist, confirm-gated tools, live
  app code, model routing, third-brain egress) unless they are named.
  Rebinding a peer starts closed. Each peer has its own rate budget.
- **Migration 0227** (`0227_mcp_login`): `mcp_login_access`,
  `mcp_login_tokens`, `session_epoch` on OAuth codes and tokens, acts-as and
  write columns on `mantle_peers`.
- **Tools:** `my_note_create`, `my_page_create`, `my_file_upload`,
  `my_item_submit`, `peer_tools`, `peer_call`, `peer_file_copy`. **Admin
  API:** `/api/mcp-logins`. Switching a login's MCP off revokes its grants
  and tokens.

## 0.235.3: new brains start with the house style and Medium thinking

`DEFAULT_PREFERENCES` seeds the no-dash house style and a Medium (4096)
thinking budget when a profile row is first made. Existing rows keep their
values.

## 0.235.2: no document titles as entities; initials join full names

- A project or event mention on a file node is dropped when it is the
  node's own title, or a bare numbered-work label. The prompt says the same.
- `reconcileEntity` matches a person's initials to a full given name on the
  same surname (unique match only); the dedup review gains initials groups.
  `entities-title-cleanup` is a dry-run-first SQL cleanup with a JSON
  backup.
- **Fix:** entity dedup always saw 0 edges per entity (a drizzle column
  binding), so `pickCanonical` never used real counts.

## 0.235.0: up to 16 extractors, and the count is live

The extractor cap is 16 (was 8). The extractor re-reads the saved count
every 30 s and grows or shrinks its pool (a removed worker finishes its job
first); the time budget is live too. No restart after a change. `GET/PATCH
/api/embedding/extraction` shows the queue (working, waiting, retrying, done
in 10 minutes, dead-lettered) and sets the count.

## 0.234.13: new file bytes leave no old version to find

- A file whose bytes change (editor save, upload replace, the disk watcher)
  drops everything made from the old bytes at write time: summary,
  entities, text, schema digest, extract markers, embedding and chunks.
  The "migrated" supersede mark goes too, so search no longer sends agents
  to a page made from the old bytes.
- **Fix:** `upsertFile` rebuilt the node's data, so every editor save
  dropped the per-file `indexing: 'metadata'` flag and an excluded file went
  to full indexing. It merges now.
- A re-extract that finds no facts retires the node's live facts.
- The upload route takes `replace=true` to write new bytes over a taken name
  in place: same node, so links and history hold.

## 0.234.12: Mammouth as a chat provider

`mammouth-chat` is an OpenAI-compatible adapter for the Mammouth aggregator
(one key, many model families), chat only. A static catalog carries the
published models and per-1M rates, and the adapter reports cost from it;
uncatalogued ids stay unpriced. Live discovery appends new chat ids and
feeds `models:drift`. docs/ai-workers.md.

## 0.234.7: headless onboarding, the setup code and the terminal wizard

While no account existed, signup made its caller the owner, so a box on a
public address belonged to whoever reached it first.

- **The setup code.** `scripts/install.sh` makes `MANTLE_SETUP_CODE` (four
  groups of five, about 99 bits, never rotated), prints it while the brain
  is unclaimed, and `--setup-code` prints it again. Signup needs it while no
  account exists and a code is set (403 `reason: 'setup-code'`, audited).
  Unset changes nothing. `bootstrap-state` answers `{ firstRun,
  setupCodeRequired }`. Contract: `BootstrapStateDTO`, `SignupBody`,
  `SignupRefusedReason`.
- **The terminal wizard.** `scripts/onboard.sh` (box wrapper) and `pnpm -C
  server/web onboard` walk the wizard's own steps (`lib/onboarding-steps.ts`,
  now shared with the onboarding route) with a default for every prompt,
  resumable either way with a GUI client. Secrets come hidden or on stdin,
  never in argv. `onboard.sh` ships with the release scripts, and the
  updater installs a script the box lacks at start.
- **Core shape** is derived on every start from the box's compose files and
  profiles (`lib/compose-shape.ts`); Tika is optional only on a core box
  without helpers.
- **Fix:** a short follow-up on the member chat failed with "That did not
  go through": the query enrichment read the owner's messages, which a team
  turn may not. The team turn now passes the member's own thread.
- **Fix:** `publish-contract` fails unless every published version is
  visible on npm (it polls for up to 40 minutes).
- Client pair: jackdaw v0.6.214 (the Setup code field).
- docs/onboarding.md section 8, self-hosting.md, security.md, scripts.md,
  configuration.md.

## 0.234.6: the app inspect-to-focus overlay is gone

The Select element mode reacted only to `[data-app-region]` elements, which
apps never reliably carried. share-ui drops the inspect and select bridge
messages, the `AppSandbox` inspect props and the overlay script. Appsmith is
no longer told to mark regions.

## 0.234.5: a stable brain id

- **Migration 0226** (`0226_brain_identity`): one row, a random uuid made by
  the migration and never changed. Not a secret.
- `GET /api/auth/whoami` answers it as `brainId`, and so do device-login,
  the client code verify (device mode), token refresh and pair claim (the
  last two also gain `loginId`).
- **Every push payload** carries `brainId` and the `loginId` the device was
  enrolled for, so a phone with several logins opens the right one. `v`
  stays 1.
- **`db-restore.sh --new-brain`** gives a brain made from another brain's
  dump its own id. A plain restore keeps the dump's id and says so.
- docs/mobile-companion-backend.md (contract v1.1), deploy.md, scripts.md,
  backups.md.

## 0.234.3: "Team apps may use" becomes External access

The switch on one outside tool (mcp or http) now follows the app's sharing:
a member running a team or public app, anyone running a client-level app,
and a contact on a contact-share link past the code gate. An open link
still runs no tool, and no built-in ever runs on a link. The app must still
declare the tool; the confirmation and clearing rules are unchanged. A
contact's call lands in the share's trail as `tool`. **Migration 0225**
(`0225_tool_external_access`) renames `tools.team_apps` to
`external_access`; `PUT /api/tools/:id/external-access`,
`ToolDTO.externalAccess`, `api_tool_update external_access`. No alias.

## 0.234.1: reopen puts a task back where it was

When a task moves into done, its old status is kept in
`data.status_before_done`. `reopen: true` on `PATCH /api/tasks/:id` and
`task_update` takes it back there (or to open). Contract, additive:
`TaskRow.statusBeforeDone`, `TreeItemMeta.reopensTo`.

## 0.234.0: the apps audit fixes

The rest of the apps audit of 2026-10-02, on top of Phases 0 to 4.

- **An imported package gets no tools.** A `.mantleapp` is a file from
  anywhere, and its declared tools used to be granted at once. Import now
  installs with an empty allowlist and answers `requestedToolSlugs` (this
  brain has them) and `droppedToolSlugs` (it does not), for the owner to
  grant with `app_tools_set`. `app_import` always waits for the owner in a
  client turn.
- **History pruning** runs in one statement under the lock, so a row added
  meanwhile (a `pre_delete`) is never pruned with its file. It also keeps a
  byte budget: `APP_SNAPSHOT_AUTO_MAX_MB` per app (default 1024) and
  `TABLE_HISTORY_MAX_MB` per table (default 512), the newest always kept.
- **Restores.** A data restore works when the live file is lost (the undo
  snapshot keeps the code only). A code restore no longer changes the live
  tools; it names the restored code's tools as `declaredTools` when they
  differ. A full restore and an undelete keep the snapshot's draft. A seed
  batch holds the registry row lock, so a restore waits for it.
- **Schema versions** declared by `app_db_schema_set`, the import route and
  `apps:push` start past the database's own version (after a data restore
  or an undelete a new schema used to be skipped).
- **Export dirty marks.** Every app write also stamps `last_write_at`, and a
  sync clears the mark only when no write came after its read. **Migration
  0223** (`0223_app_table_exports_last_write`).
- **Builds.** A build of source that changed meanwhile is not staged; the
  build step builds again (twice at most).
- **The error log** is bounded per caller (10 rows a minute each, 30 for all
  non-owner callers together, 2000 a day per app), the reaper drops error
  rows after 14 days and past the newest 2000, and `app_errors` fences its
  rows as untrusted visitor data. **Migration 0224**
  (`0224_app_access_log_error_idx`): a partial index for the error rows.
- **Imports** stream the upload to a spool file, check the size before
  reading, and take a turn from one per-process limit (two at a time). A zip
  with more than 16 entries is refused before parsing. A step that fails
  after the install drops the half-made app.
- **Backups** hard-link the two history trees instead of copying them; the
  table history copies run in a SQL child, off the event loop.
- **Lows.** Entry checks use `Object.hasOwn`. The Recently deleted and
  History lists read from the row, not the code JSON (**migration 0224**,
  `0224_apps_audit_lows`, adds the file count, source size and draft flag).
  A tool confirmation ticket is used once. The nightly `app-trash-purge`
  also sweeps work files a crash left behind after an hour.
- **share-ui:** `AppSandbox` refuses a second tool confirmation while one is
  open, and the browser-dialog fallback shows the start and the end of a
  long input.

## 0.234.0: app_export and app_import, the package as a brain file

- **`app_export` / `app_import`** (owner only, group apps, also on MCP): an
  agent saves an app as a `.mantleapp` file under /files (folder exports)
  and makes a new app from one; the Appsmith prompt teaches them with
  `app_duplicate` and `app_errors`.

## 0.234.0: table history (apps first-class, Phase 4)

- **Every table commit keeps the version it replaces** (a hard link, no
  copy) on the table's history; the newest 20 per table, plus the owner's
  own snapshots (never pruned, within `APP_SNAPSHOT_MAX_MB`). **Migration
  0222** (`0222_node_snapshots_table_commit`) adds the `commit` trigger.
- **Restore** puts a version into the table's draft; review, then commit
  (or `commit: true`). The commit keeps what it replaced, so a restore is
  undone the same way.
- **Tools** (owner only, group `tables`, also on MCP): `table_history`,
  `table_snapshot_create`, `table_snapshot_restore` and
  `table_snapshot_delete` (both confirm-gated). `table_commit` and
  `POST /api/tables/:id/commit` take a `note`.
- **Routes:** `GET/POST /api/tables/:id/history`, `DELETE …/history/:sid`,
  `POST …/history/:sid/restore`, `GET …/history/:sid/download`.
- The table backup copies the history; `app-trash-purge` also clears a
  deleted table's history after 30 days. The Ledger agent and the
  `table_authoring` skill teach the history. docs/tables.md section 4.

## 0.233.2: app export, import and duplicate; the app error log (apps first-class, Phase 3)

- **`.mantleapp` export and import.** `GET /api/apps/:id/export` downloads a
  zip of the code and a copy of the data (`?data=0` without).
  `POST /api/apps/import-package` (the file as the raw body) makes a new app
  from one: the package, schema and database (SQLite quick_check, then a
  clean copy in the SQL child) are checked before anything is made; the code
  is built here and published when it was published; unknown tools are left
  out and reported. docs/app-authoring-guide.md, "Export, import and
  duplicate".
- **Duplicate.** `app_duplicate` / `POST /api/apps/:id/duplicate` copies an
  app with its builds (live at once), draft, tools, schema and data
  (`with_data: false` for code only). Admin-only, unshared, no history but a
  "copied from" version, no table exports.
- **App error log (G4).** Every broker (owner, member, client, share) logs
  the errors it answers a running app with: kind `error` in
  `app_access_log`, with the message, the SQL or the tool slug, who ran it
  and the status. Capped at 30 rows per app per minute; busy waits are not
  logged; a server fault keeps the generic text. Read with `app_errors`
  (owner only, group apps) or `GET /api/apps/:id/access-log?kind=error`
  (`kind` and `limit` are new). An access-log write that throws before it is
  sent no longer reaches the caller.
- **App table exports survive a restart (D8).** The first app write of a
  burst stamps the app's exports `dirty_since` (**migration 0221**,
  `0221_app_table_exports_dirty`); the sync that reads the rows clears it.
  The web process resumes the dirty ones at boot. The maintenance task
  `app-export-catch-up` (`pnpm -C server/web app-export:catch-up`, dry run
  unless `--apply`) syncs any dirty for 20 minutes; by hand only, since a
  changed table is re-indexed (not on the nightly cron).

## 0.233.1: recently deleted apps, app_update, an import that checks first (apps first-class, Phase 3)

- **Recently deleted.** Deleting an app keeps a `pre_delete` snapshot (code,
  name, look and data) and its history for 30 days; it comes back with the
  same id (`app_undelete`, `POST /api/apps/deleted/:id/restore`), admin-only
  and unshared. `app_deleted_list` / `GET /api/apps/deleted` list them;
  `DELETE /api/apps/deleted/:id` purges one now; the nightly
  `app-trash-purge` sweep (`pnpm -C server/web app-trash:purge`) after 30
  days. A delete whose snapshot cannot be taken does not happen.
- **Migration 0220** (`0220_node_snapshots_outlive_node`): drops the
  node_snapshots foreign key so the history outlives the app.
- **`app_update`**: rename an app, change its description, icon, colour or
  tags. `PATCH /api/apps/:id` takes `description`.
- **Import checks first.** `POST /api/apps/import` validates the tool slugs
  and tries the schema before it writes anything (a bad one used to leave a
  half-made app), follows the create route's field rules, and snapshots an
  existing app before it overwrites it.
- **One build step** (`buildAndStageApp` in @mantle/tools) behind `app_build`,
  Preview, Commit, import and `apps:push`.

## 0.233.0: app history, versions and snapshots (apps first-class, Phase 2)

An app's code AND its data can now be put back
(docs/app-authoring-guide.md, "History: versions and snapshots").

- **Versions.** Every publish records the code that went live, with an
  optional note (`app_publish` takes `note`).
- **Snapshots.** The code and a copy of the app's database
  (`app_snapshot_create`, or the History tab). One is taken automatically
  before every restore and before `app_db_schema_set` changes the schema of
  an app with data. The newest 20 automatic ones are kept per app; the
  owner's own count against `APP_SNAPSHOT_MAX_MB` (default 2048).
- **Restore** in three modes (`app_snapshot_restore`, confirm-gated, or
  `POST /api/apps/:id/snapshots/:sid/restore`): `code` into the draft,
  `data` back as the live database, `full` both live. A data restore puts a
  marker beside the file: every broker and the SQL child answer busy (429)
  for the few seconds the swap takes.
- **Routes:** `GET/POST /api/apps/:id/snapshots`, `GET/PATCH/DELETE
  …/snapshots/:sid`, `…/restore`, `…/download` (the `.sqlite` copy).
- **Tools:** `app_snapshot_create`, `app_snapshot_list` (group `apps`);
  `app_snapshot_restore`, `app_snapshot_delete` (group `app-admin`, both
  confirm-gated).
- Contract: `@crossworks/client-types` gains `AppSnapshot` and
  `AppRestoreMode`. Additive.
- The backup copies each app's snapshots with its database; deleting an app
  removes them.
- **Migration 0219** (`0219_node_snapshots`): the `node_snapshots` table (one
  numbered line per item, apps now, tables later), `apps.restored_from_seq`,
  and v1 for every published app (pure SQL).

## 0.232.387: apps speed (apps first-class, Phase 1)

- **Running an app reads less.** The db and tool brokers and the frame
  routes (owner and `/s`) load the app through `getAppRuntime`: its level,
  manifest and builds. They used to load the whole app (published and draft
  source, up to 50 × 256 KB each, the share, the owner's preferences) on
  every `host.db.query` and tool call.
- **The app list** reads only the columns a row shows: no draft source tree
  (it asks `draft_source IS NOT NULL`) and no node embedding.
- **Opening an app** serves its bundle and CSS from a 32 MB in-process cache
  keyed by content hash, instead of reading object storage on every load.
- **Off the main thread:** the authoring-time seed (`app_db_seed`, now one
  transaction in a SQL child via `runAppSqlBatch`), the schema read behind
  `app_db_list`, and the backup's per-app copy (`copyAppDbFile`).
- `app_db_list` reports an app whose database is missing on its own line
  instead of failing the whole list.
- **Migration 0218** (`0218_app_access_log_created_idx`): an index on
  `app_access_log.created_at` for the retention reaper. Additive.

## 0.232.386: apps safety (apps first-class, Phase 0)

The first slice of the apps audit of 2026-10-02: the fixes the snapshot and
restore work depends on (docs/app-authoring-guide.md, "Per-app SQLite").

- **A lost app database is an error, not an empty app.** An app that stored
  something and lost its file used to get a new empty file, with its schema
  not re-run, so every statement failed with "no such table" and nothing
  said why. Now every read and write refuses (`AppDbMissingError`; the
  brokers answer 503 `reason: 'missing'`), the agent's `app_db_query` and
  `app_db_list` say so instead of returning no rows, and the log names the
  path.
- **A bad schema can no longer stop a live app.** `app_db_schema_set`, the
  import route and `apps-push` try the script on a copy of the app's live
  database first (`checkAppSchemaScript`, a VACUUM INTO copy in a SQL
  child, off the event loop) and refuse one that fails there.
- **Schema versions apply once.** The applier takes a row lock, so web and
  api cannot both run a version, and the script stamps its version into the
  file (`user_version`, in the same transaction): a crash between the
  SQLite commit and the registry update is skipped on the next run instead
  of failing on "already exists".
- **The owner's db-broker** answers errors like the other brokers (429 when
  busy, the server's own errors not shown) and runs one statement at a time
  per admin login.
- **A tool that needs confirmation asks the owner first.** An owner's app
  could run a tool flagged "needs confirmation" with no confirmation. Now
  the owner tool broker answers 409 `reason: 'confirm'` with a five-minute
  ticket for that exact call (tool, input, app, login); the host page shows
  the owner what will run and sends the call again with the ticket on Yes.
  The app never sees the ticket. `AppSandbox` (share-ui) takes
  `confirmTool`; without it the browser's own confirm dialog asks.
  `app_tools_set` warns when it declares such a tool. Member, client and
  share runs refuse these tools as before.
- **Edits in flight no longer overwrite each other.** The editor's autosave,
  the assistant's file writes (`app_file_write` / delete), the manifest
  setters and publish now take the app row's lock: two writes in flight keep
  both changes, and a publish cannot clear a draft saved while it ran. The
  draft PUT takes `baseDraftUpdatedAt` and answers 409 `reason: 'conflict'`
  when the draft changed since the editor read it (the assistant wrote a
  file); `AppDetail.draftUpdatedAt` carries the stamp. Without the field a
  save goes through as before.
- **Delete removes the app before its database file**, so a delete that
  fails no longer leaves an app whose data is gone.
- **`scripts/app-dbs-restore.sh`** removes each restored file's old `-wal`
  / `-shm` first, so SQLite cannot replay a stale WAL into the restored
  database.
- **The public share routes cap the request body** (1 MB, `/s/**`): the
  gate refuses a declared length over it, and the app db-broker and the
  formula `evaluate` route stop a chunked body while reading. The share
  db-broker used to buffer any body an anonymous caller sent.

## 0.232.384: app identity, an app knows who runs it

A mini app can show who runs it and record who did what, and the record
cannot be faked from the browser (docs/app-authoring-guide.md, "Who is
running the app").

- **`host.me()`** answers `{ id, name, kind }` on every surface (the
  editor, member and client shells, a Contact share, an open link). `kind`
  is `admin`, `member`, `client`, `contact` or `public`. No email. The frame
  route bakes it into the frame document from its verified ticket, so the
  bridge protocol and the hosts do not change; the owner frame ticket now
  names the admin login (`act`).
- **Server-filled SQL parameters** `:host_me_id`, `:host_me_name`,
  `:host_me_kind` in `host.db.query` / `host.db.exec`, filled by every
  broker (owner, member, client, /s). A browser value under any `host_me_`
  name is refused (400), and so is an unknown one (`:host_me_email`). SQL
  without them is unchanged. A caller that names no person (the assistant's
  `app_db_query`) cannot use them. The access log is unchanged.
- **Per-app pseudonymous id**: HMAC of the login or contact id, keyed with
  a random per-app salt. **Migration 0217** (`0217_app_viewer_salt`):
  `app_databases.viewer_salt`, nullable, filled on first use.
- Contract: `@crossworks/client-types` gains `AppViewer` / `AppViewerKind`
  (and the `app-viewer` subpath); `@crossworks/share-ui` re-exports the type
  and its frame builder takes an optional `viewer`. Additive.

## 0.232.383: a tool group answers its level

`ToolGroupDTO.audience` (optional in the contract) is set from the row, so
`GET /api/tool-groups` and `GET /api/tool-groups/:id` carry the group's
level. The owner UI shows and sets it with it. No migration.

## 0.232.382: an item deleted during a save drops out of its embeds

`mantle_sync_embeds` checked that an embedded item exists, then inserted the
edge. An item deleted in between failed the foreign key, and with it the
user's save of the page, drawing or note. **Migration 0216**
(`0216_embed_sync_skips_deleted`) replaces the function: the insert joins
the target and locks it for key share, so a delete in flight is waited for
and the row skipped.

## 0.232.380: "Team apps may use", an admin switch on one outside tool

A member's run of a team app could call only read-only built-in tools, so a
site's own connectors were refused in every team app. (Renamed External
access in 0.234.3.)

- **Migration 0215** (`0215_tool_team_apps`): `tools.team_apps`, set when an
  admin confirms the tool only reads, with who and a signature of the
  handler. It counts only while that signature matches, so any handler
  change voids it; tool edits clear it.
- mcp and http tools only (no PUT, PATCH or DELETE); never recipe or shell;
  never a tool that needs confirmation. The app must still declare the tool.
- `PUT /api/tools/:id/team-apps` (admin logins); `api_tool_update` takes
  `team_apps` and `read_only_confirmed` (on only from the owner's MCP client
  or tool console); `ToolDTO.teamApps`. Each switch writes an audit row.

## 0.232.379: contact shares, one item for one contact

An admin shares ONE workspace item with ONE outsider, without showing it to
the team (docs/sharing.md section 4b). The item's level never changes.

- **Migration 0214** (`0214_contact_shares`): `contact_share_codes` (one row
  per contact that ever had sharing: an HMAC of the code keyed from
  `MANTLE_MASTER_KEY`, an epoch that only goes up, the failure counters and
  the lock), `shares.contact_id` and `shares.can_write` (apps only, a
  CHECK), a trigger (a contact of the same owner, a workspace item, never a
  folder), the open-link unique index split from a per-contact one, and
  `share_access_log`. A lock change raises `needs_you_changed`.
- **The contact.** "Enable sharing" makes an 8-character code, shown once.
  Regenerate, switch off (revokes every share), a "Locked" state after 30
  wrong codes in a day (24 hours, a "Needs you" notice). The contact DTO
  carries `sharing`. Deleting the contact removes its code and shares.
- **The gate.** A contact share's `/s/<token>` opens only with the
  contact's `mantle_contact` cookie (path `/s/`, 30 days), set by
  `POST /s/<token>/code`. Without it: the code prompt (401, no title) and
  401 on every other route. Same 401 and same work for every failed code;
  limits per address, per share (10 an hour) and per contact (30 a day).
- **What a contact may do.** Read the item and what it embeds, at any
  level. An app with "Can write": write its SQLite (export sync scheduled,
  `client_written_at` marked). Never brain tools. A "Shared with you" menu
  on the view links the contact's other live shares.
- **Owner API.** `POST /api/contacts/:id/sharing`, `GET` and `DELETE
  /api/contacts/:id/shares` (the "Shared" tab, Revoke all),
  `POST /api/shares/contacts`, `PATCH /api/shares/:id { canWrite }`;
  `DELETE /api/shares/:id` on a contact share changes no level.
  `contactShares` on the access view and `access_get`; Shared links name
  the contact.
- **Levels.** Every level path reads open links only: a level change never
  touches a contact share, and the other open-link queries (client report,
  old client links, comments visibility, app share mode) skip them.
- **Contract** (`@mantle/client-types`): `dto/contact-shares.ts`,
  `AccessNodeView.contactShares`, `SharedLinkRow.contactId/contactName/
  canWrite`, `NeedsYou.sharing`; `ContactRow.sharing` in content-core.
- **Races and the trail (audit fix round).** A share create locks the
  contact's code row before its sharing-on check, so a switch off running
  at the same time cannot leave a live share; Enable from off revokes any
  live share too. A double click on Enable or on Share answers one code or
  one share, not a 500. `share_access_log` keeps its rows when a share or a
  contact is deleted (both ids SET NULL). A try the per-share limit refused
  no longer counts toward the contact lock. The tool broker and the gate
  401 write `refused` trail rows (the 401 sampled, one a minute per share);
  `contact.share_created` and `contact.share_can_write` audit rows.
- **Fix.** The code alphabet of the retired team codes is 54 characters, not
  56; the new generator rejects bytes from the real length, so every
  character is equally likely.
- **Docs.** sharing.md 4 and 4b, access-levels.md 7, contacts.md 2a and 2b,
  security.md 3, app-authoring-guide.md "Sharing an app",
  maintenance-runner.md.

## 0.232.379: public apps leave the member launcher

Public now means "anyone with the link" for an app, as it does for every
other kind (contact shares plan P0, decided 2026-10-01).

- **Member launcher.** `GET /api/member/apps` (and its folders) and the
  member home's `apps` list team and client apps only, never a public one
  (`MEMBER_LISTED_APP_LEVELS` in `packages/content/src/member-apps.ts`).
  A public app inside a folder shared with the team is still listed: the
  team reads it through the folder.
- **Running is unchanged.** A member who has a public app's link still runs
  it, read only. The pinned home app is unchanged. The contract is
  unchanged (`MemberAppLevel` still names public).
- **Docs.** `docs/member-logins.md` section 7, `docs/access-levels.md`
  section 7, `docs/team-hub-app-sdk.md` section 2.

## 0.232.378: a row deleted during the share-drift repair no longer fails the sweep

`repairShareDrift` wrote every expected embed edge in one statement, so a
node deleted meanwhile failed the foreign key and the whole nightly sweep.
It now writes only the missing edges and locks both ends for key share.

## 0.232.374: the phone app for members and clients

Members and clients can use the phone app; a push reaches one login.
docs/mobile-companion-backend.md, member-logins.md, client-logins.md.

- **Sign-in:** `POST /api/auth/device-login` (admin or member, the answer
  names the role), the emailed client code in device mode (a bearer, no
  cookie), refresh for all three roles, `GET /api/auth/whoami`. A client's
  device refreshes for at most 90 days from the code that signed it in. A
  rotated token presented after its successor was used ends the login's
  sessions once (`auth.token_reuse`). Device mode refuses a browser page.
  Dead device tokens are reaped nightly.
- **Push:** the owner's teasers, approvals and Needs you go to active admin
  devices only. A member or client enrols its own phone
  (`/api/member/push`, `/api/client/push`); a device is pushed to only while
  the token that enrolled it is live. Ten devices a login, the oldest goes.
  The `login_notice` channel tells one login about a reply in its chat, a
  review result or a comment. Teasers are plain words, not markdown.
- **Unread:** a per-login read cursor for the member and client chat thread.
- **Migration 0213** (`0213_mobile_roles_push`): one row per routing token,
  the login binding, and old rows bound where the login holds exactly one
  live phone token.
- **Fix:** an unpair or a sign-out no longer answers 500 when the relay
  identity cannot be read.

## 0.232.373: a restored brain keeps its folder share refresh

Every `pg_restore` of a dump taken at migration 0204 or later gave one
error (`operator does not exist: public.ltree = public.ltree`) and the
restored brain had no `nodes_share_refresh_after` trigger: 0204 compared the
ltree `path` column with `IS DISTINCT FROM` in the trigger's WHEN clause, a
form pg_dump cannot write so that a restore can run it. On such a brain a
folder share, unshare, move or rename no longer reached the rows below the
folder (an unshare failed open). `scripts/db-restore.sh` went on and said
"Restore complete, WITH 1 pg_restore error(s)". A brain migrated in place
never lost the trigger.

- **Migration 0212** (`0212_restorable_share_refresh_trigger.sql`,
  idempotent) locks `nodes`, sets every stale `inherited_level` right (a
  brain that never lost the trigger is not written) and makes the trigger
  again on the text of the path, which a dump can carry. A brain restored
  without the trigger is repaired on its next migrate. Where the
  maintenance worker runs, the nightly `share-drift` sweep had already
  bounded a stale level to about a day; its run history shows whether a box
  was hit. To check a box: `select count(*) from pg_trigger where tgname =
  'nodes_share_refresh_after'` (1 is right). A "lock timeout" on 0212 in a
  roll means a long transaction held `nodes`: run the roll again.
- **`scripts/db-restore.sh`** checks every trigger the dump lists
  (`pg_restore --list`) and exits 2, without "Restore complete", when one is
  missing. After a dump from before 0212 it makes the one trigger such a
  dump cannot carry, as 0212 does, and from 0204 on it fails the restore
  when that trigger is not there. It exits 3, after its last step, when
  `pg_restore` reported an error it cannot explain; it never says "Restore
  complete" over one. On exit 2 and 3 the full `pg_restore` output is kept.
- **Tests.** `packages/db/src/dump-restore.db.test.ts` dumps a migrated
  brain with a few rows (`pg_dump -Fc`), restores it into an empty database
  and asks for no `pg_restore` error and the same triggers, policies,
  functions, constraints, indexes and rows on both sides; it also proves
  that 0204's own trigger is lost that way. `share-refresh-restored.db.test.ts`
  proves the repair, and `db-restore-run.db.test.ts` runs the restore script
  against six dumps (exit 0, 2 and 3). No other stored expression in the
  schema has the pattern.

docs/access-levels.md, section 6.

## 0.232.372: tree reads never need write rights

`GET /api/tree/:kind`, `/api/tree/:kind/marks` and `/api/app-nav` answered
500 on a database that refuses writes (a read-only replica, a SELECT-only
role): each read began with an unconditional insert of the kind's root row.
Every step a tree read makes for itself now looks first, writes only what is
missing, and skips a refused write (`bestEffortWrite` in @mantle/db, with a
five-minute pause per call site). The same guard covers the onboarded stamp
(`GET /api/onboarding`), a peer's last-seen stamp and the share view
counter.

## 0.232.371: the team responder opens in one step on a fresh install

`team-read` and `formulas-eval` are team level in the manifest, but a brain
installed after migration 0159 seeded both at admin, so lowering the team
responder to team answered 400 `group_above_agent`. A fresh install seeds
them at team, and the boot reconcile fixes brains installed with the wrong
levels (no migration). `setAgentAudience` takes `dropGroupsAbove` (API
`dropGroupsAbove`, `access_set drop_groups_above`): the groups above the new
level leave the agent in the same call and come back in `removedGroups`. The
plain call is still refused, and the refusal names each group and the fix.

## 0.232.368: the team and client Apps launchers get the folders

`GET /api/member/apps` and `GET /api/client/apps` answer `folders` next to
`apps`: where the apps a reader may run sit in the admin's Apps folders,
read only (`AppLauncherFolder`: id, name, icon, colour, `parentId`,
`appIds`). A folder is answered only when it holds, at any depth, an app of
the same answer, so a folder of admin apps, of drafts, or of nothing is
never named, whatever its share. The existing fields are unchanged; an
older client ignores `folders`. Apps stay out of the reader tree kinds: the
rule to run an app (published build, no embed, client level exactly for a
client) is the list's own. A failed folder read never hides the apps: the
answer then carries no folders. docs/folder-tree.md, "Apps for members and
clients".

- **Fixed: a member's tree by name.** In a search and in the A to Z view
  (`GET /api/member/tree/:kind/search`) a member's drafts were put first in
  the order they were last changed (Beta before Alpha), and only the first
  page carried any, so a member with more drafts than a page never saw the
  rest. Drafts and the brain's items are now one list by name, paged by one
  cursor; a page holds at most `limit` items.

## 0.232.365: folder system phase 7, pages in folders

Pages join the item tree like notes, and a page is never the parent of
another page (Jason, 2026-09-30: pages live in folders exactly like notes;
no page children; no index pages; a page may reference another page
without it becoming a child; nothing is lost). Plan: "PLAN: Universal
folder system", section 10; docs/folder-tree.md, "Pages".

- **Pages are a live tree kind.** `GET /api/tree/pages` and the member and
  client trees serve them; folders, three levels, shares and their
  inheritance, embeds and the confirm diff apply as for notes. The tree
  tools take `kind: 'pages'` and sit in the `pages` tool group; a private
  page shows at the root of the owner's tree.
- **Migration 0210** (`0210_pages_in_folders.sql`, idempotent) files the
  old hierarchy: every page that had child pages becomes a page next to a
  folder of its name, its former children move into that folder (a child
  with children makes its folder inside its parent's), cut to three levels;
  every page's `parent_id` that named a page is cleared (it was ON DELETE
  CASCADE); a stray `pages.<id>` path lands at the deepest folder above it.
  Folder slugs follow `folderSlugOf` (`mantle_folder_label` in SQL, pinned
  to the TypeScript by a test); a taken slug gets `-2`. A member's nested
  draft becomes the member's own folder.
- **Creating and moving.** `createPage` takes `folderId` (the deprecated
  `parentId` means "the same folder as that page"); `POST /api/pages` takes
  `folderId`; `POST /api/pages/:id/move` files a page in a folder through
  the tree's item move, with the 409 `visibility` confirm. `page_create`
  and the `page_from_*` tools take `folder_id`; `page_move` takes
  `folder_id` or `to_top_level` and `confirm`. Accept lands a page like a
  note (`folderId`; `parentPageId` is ignored). `page_split` and
  `page_extract_section` (`extractSectionToPage`) make pages next to the
  source, in the same folder.
- **The page link card.** The `childPage` block (`[Title](page:<id>)` on its
  own line) is a link to another page, still an embed edge (0208), never a
  parent-child bond. The public renderer keeps its inert label.
- **The Folder index block** (`folderIndex`; `[Folder index](folder:<id>)`
  or `folder:here` on its own line): a live, title-only list of a folder's
  pages as the reader sees them (the owner's, member's or client's tree
  read); the open link renders an inert label; it indexes as nothing.
- **Gone with the nesting**: `movePage`, `listChildPages`,
  `countPageDescendants`, `withPagePlacement` (list rows are plain
  `PageRow`s; `childCount` and `parentTitle` are absent), the "Share
  sub-pages" cascade (`setShareCascade`, `listPageDescendantIds`,
  `POST /api/shares/cascade`, `page_share`'s `children`, the `preferred`
  level on `createShare`): a set of pages is shared by sharing its folder.
  Kept on the wire for older clients: `PageRow.parentId` (null),
  `AccessNodeView.childCount` (0), a link's `cascade` (false),
  `GET /api/pages/:id/descendant-count` (`{ count: 0 }`).
- `PageDetail.folderId` names the folder a page sits in (null at the top
  level; null too when the reader may not read the folder row).

## 0.232.363: Recall R5, page-built maps retired

Recall v1 compiled a map from a page tree whose root carried the `recall`
tag. The dev maps were re-authored as native maps (R4), so the compiler and
everything around it goes (Jason, 2026-09-30: "completely remove the Page
Built Maps, that is legacy").

- **A map is only a native `recall` item.** The page compiler, the page
  hooks (create, commit, update, move, delete), the extractor's metadata-only
  path for map pages, `GET /api/recall/pages/:id`, the compile report
  (`lastCompileOk`, the map `report`, `RecallLintIssueDTO`,
  `RecallPageStateDTO`) and the v1 fallbacks in `recall_open` and
  `recall_map_get` are removed. `content-core/recall-compile` keeps only
  `recallSlug` and the two caps clients read.
- **`recall` and `prompt` are ordinary page tags** again; agent page tools no
  longer strip them.
- **Nothing serves a leftover v1 row.** Every serving read, the owner API and
  the write path require `recall_maps.node_id`, so a row without its tree item
  is never listed, opened, followed, matched, embedded or written.
- **Migration 0209** deletes those rows (their cards cascade) and names them
  in a NOTICE. `last_compile_ok` and `last_compile_report` stay, unused, so
  the previous release still runs after a rollback.
- **`scripts/roll.sh` refuses a box that still has a page-built map**, naming
  its slugs; `ROLL_ALLOW_V1_RECALL=1` overrides for a map the owner agreed may
  go. Pre-roll checks and the rollback note are in docs/update-prod.md.
- The in-app Recall help page is rewritten for native maps, and the folder
  tools' `kind` hint now names `recall`.

## 0.232.361: a folder delete merges; embeds follow their embedder

Follow-up to the folder system audit of 2026-09-30 (findings C2 and S5),
decided by Jason the same day.

- **A folder delete always merges** (plan section 5, option B; it used to
  refuse on any clash). What the folder holds lands one level up; a
  subfolder whose name is taken there merges into that folder,
  recursively, and the folder that was there keeps its name, look and
  share. A file whose name is taken gets `-2` (`report-2.pdf`, as
  Auto-filed does); other kinds may share titles and keep theirs. A
  subfolder named like the deleted folder takes its place. Rows-only kinds
  do it in one transaction; Files check everything read only first
  (untracked files in every directory that goes, a name already on disk
  where a folder moves up) and then move child by child, disk first.
  Members' drafts follow by path. The visibility confirm compares each row
  at its real landing place: what merges into a shared folder takes its
  share and is listed.
- **Embeds follow their embedder** (audit S5; Jason: an embed "should not
  show it anymore as technically it does not have permission"). A folder
  share no longer lowers the own level of what its pages, drawings and
  notes embed. **Migration 0208** keeps the embed edges (`node_embeds`, by
  triggers on `pages.doc`, `draws.file_refs` and a note's markdown) and a
  derived `nodes.embedded_level`: an embed is read through a shared
  embedder, transitively, only while that embedder is. Unshare, move out,
  delete the folder or take the embed out, and the access goes; nothing's
  own level moves. `nodes_viewer_read` reads own level OR inherited share
  OR embedded level (still a same-row check); the reader checks, the
  client-exposure checks, the page text folding and the tree's `level`
  (with `embedded`) follow; the client thread does not. Accept and saves
  lower embeds only to the item's own level. The visibility refusal lists
  `alsoEmbeds` (from, to and type) instead of the unreleased
  `alsoLowered`; an embed opens any workspace item it names (Jason: a
  shared folder shares everything in it), never an admin-only kind. An
  Accept into a shared folder lists what its bundle embeds too. The agent
  tools that write note and page content say it. Page, note and drawing
  saves retry once on a lock clash, then answer 409 "try again". The
  nightly `share-drift` sweep repairs edges and embedded levels too.
  Review fixes: an unshare closes a loop of embeds; a drawing embeds what
  its published scene places (a draft opens nothing); an embed opens an app
  for reading only; the Access control, access_get and the rows say what
  an item is read through (readThrough, embedded) and floor at it; the tree
  confirm counts every embed a change opens (embedsTotal, in seen) and asks
  when only embeds change; Accept lists what its bundle opens even at the
  folder's own level; a member's note save checks every media id.
  Measured: 0208 takes about 15 s on a 212,000-row brain (10,000 pages,
  20,000 notes, 180,000 edges); the largest live brains are about 100
  times smaller.
  Existing data: items lowered by earlier folder shares keep their level;
  nothing is raised.

## 0.232.360: folder system audit fixes

From the folder system audit of 2026-09-30 (dev brain, "AUDIT: Universal
folder system, phases 1 to 5") and a second audit's review.

- **Nothing changes who can see an item without asking.** Accept in place
  now checks the share of every folder its items land in (the item and its
  bundle, the legacy Files folder too, for a reviewed and an admin's own
  Accept) and answers 409 `visibility` with the list until
  `visibilityConfirmed`; the client-level confirmation and the embeds
  follow the level the item is read at. The Files screen's move, copy and
  new-file routes, uploads, and the agent tools `file_move`, `file_copy`,
  `folder_move`, `folder_copy`, `file_create` and `file_upload` ask the
  same way (`confirm`). `tree_folder_update` declares `confirm` (over MCP
  it could never go ahead), and a test pins that every tool reading it
  declares it. A confirm may carry `seen`; a different change by then is
  asked again. The refusal also lists the embeds that go down with it
  (`alsoLowered`).
- **Migration 0207**: a shared folder deleted by any writer leaves no share
  behind; an unshare can no longer race an insert into the folder (a share
  lock in the triggers for rows under shareable roots, always taken before
  row locks, with a 10 second wait; a conflict answers "busy, try again");
  the share refresh skips brains with no shared folder. A nightly `share-drift` sweep repairs and reports any row read at
  a share its folders no longer give.
- **Files folder tools and operations refuse another kind's folder** (a
  notes folder deleted through them left its notes behind with their
  share), a kind root and an Auto-filed folder.
- **A member's tree never reveals a folder the member cannot see** (naming
  an own folder like a hidden one showed its name, look and id); a member
  keeps at most 500 folders per kind; the tree counts children in one pass
  (it was quadratic) and pages drafts like items. A member's folder holding
  a submitted draft stays put until the review is done.
- A copy into a shared folder asks too (copies take the destination's
  share, never the shares inside the source).
- Agents can make and move Recall folders (`tree_*` with kind `recall`).
- Notes, drawings, files and Files folders report the share they inherit
  (`inherited`; folders also `share`), so screens show the level an item is
  read at.
- Smaller: folder renames and moves re-check on locked rows; a combined
  folder update checks its share before writing anything; a Files
  delete-lift refuses over untracked files before moving anything; a
  forged tree cursor restarts at the top; an app in a client-shared folder
  counts as a client app for the client-sourced rules.
- Tests: the viewer DB tests no longer race on the cluster-wide viewer
  roles, and the two client byte-total tests share a lock; a full
  `packages/content` run is green 3 of 3 on a fresh database.

## 0.232.356: client v0.6.184 (folder system and Recall v2 screens)

- Pairs the client at jackdaw v0.6.184. It brings the UI for the folder
  system, phases 2 to 5: one folder tree on every item screen, folder
  sharing with the visibility confirm, member and client trees, members'
  own folders and drafts in place, and the Accept dialog's "Where it
  goes" with a folder picker. It also brings the Recall v2 screens (the
  native map editor and Recall in the item tree, behind
  `features.recallV2`).

## 0.232.354: the universal folder system, phases 2 to 5

- **One folder tree for every item kind** (docs/folder-tree.md). Notes,
  drawings, tables, formulas, tasks, events, contacts and secrets join
  Files on the tree (phase 2); Apps' layout document becomes folder rows,
  with pins and opens in `item_marks` (phase 3). Agents get folder tools
  for every row-only kind.
- **Share a folder** with the team or clients: everything in it, now and
  later, is read at that level (phase 4, migration 0204). A tree write
  that changes who can see something asks first (409 `visibility` until
  confirmed); Accept, the Files routes and the Files agent tools did not
  yet (fixed after the audit, above). Access control says "Shared via" the
  folder. Members and
  clients browse read-only trees of what they may read; folder-shared items
  reach the member Library, the client's "Shared with you", redaction,
  images and apps; the owner's gates count folder shares. Clients comment
  on folder-shared items (migration 0205).
- **Members file drafts in place** (phase 5): private folders of their own
  inside any folder they see, new drafts and uploads filed there, a merged
  tree with their drafts and teammates' shared drafts. Brain folder renames,
  moves and deletes carry members' drafts along. **Accept claims in place**:
  a draft lands where its author filed it, the author's folders becoming
  brain folders; the admin may pick another folder.
- Migrations 0204 (folder sharing; the Recall root joins the folder depth
  check) and 0205 (the client thread on folder-shared items) run after
  main's 0201 to 0203. Pairs with jackdaw's folder phases 2 to 5.

## 0.232.352: the universal folder system, phase 1 (Files)

- **Files gets the folder tree** (docs/folder-tree.md): folders nest at
  most three levels (writers refuse or clamp; a deeper directory made on
  disk stays out of the brain), a folder's name is kept apart from its slug
  (the path label and the directory name), pins and opens live in the new
  `item_marks` table, and the tree pages 50 items at a time.
- **Auto-filed**: everything Mantle files by itself now lives under
  `files/auto-filed/` (assistant and Telegram uploads, exports, generated
  images, video, extracted images, sandbox exports, API docs), dated
  folders by month. On first start the file watcher moves an older brain's
  top-level machine folders there ON DISK and merges day folders into
  months (a clashing name gets `-2`). Operators: expect those top-level
  Files folders to move.
- Migration 0201 (`item_marks`, the folder depth check, added NOT VALID).
  (Entry added after the fact, by the folder audit.)

## 0.232.351: client v0.6.180 (whole client tier audit)

- Pairs the client at jackdaw v0.6.180, the client half of 0.232.350.
  Admins see and answer the client thread on drawings. A client's pictures
  load from the client routes in its own editor and in notes, sub-page cards
  make no admin call, and staff screens show no remote pictures from client
  text. Clients no longer read "admin" or "Library". A large client draft is
  saved again after a reload. Sign out from a neutral screen goes to the
  client sign-in. The storage card shows what client apps' databases hold.
  The Informational switch shows on team and client apps only.

## 0.232.350: whole client tier audit fixes

- **Client-level apps run the client tool rules for every runner**: an
  admin's or a member's run of a client-level app can no longer read team
  or admin data into a database every client reads (audit L1).
- **App databases are bounded**: 256 MB a file (`APP_SQL_MAX_DB_MB`), 8 MB a
  reply, one statement at a time per caller; server error text never
  reaches an app (I1, L4).
- **Client app exports** index at retrieval depth and commit at most every
  10 minutes; a Table that holds rows clients wrote stays client-sourced
  after its app is raised or its export removed (I2, I3, migration 0199).
- **Access log upkeep**: reads sampled once a minute, no audit row per
  client broker call, a 90-day sweep (I4). App write tools are owner only
  (I8).
- **Give back** reads absolute brain URLs as references (L2). Deleting a
  client login deletes its comments; its log rows read "Removed client"
  (I5). A trigger refuses any role change to or from client (migration
  0200). Race tests for the client caps (I7). A client's embed refusal no
  longer names the Library (U6).
- Roll notes: update-prod.md, "Rolling to v0.232.350".

## 0.232.349: the notes behind the top facts get a passage

- **Retrieval reads the note a matching fact came from.** A fact is one
  sentence, so it matches a question far better than a whole passage does.
  Now up to 3 of the top facts' source notes that have no passage in the
  context get their closest passage, inside the same chunk_limit (empty
  slots first, then the weakest passages make room). The memory limits are
  unchanged; one small extra query per turn, no model call. The average
  context grows about 10% (slots the passage cutoff used to leave empty now
  fill). LoCoMo at the default limits, same ingest: 84.0% to 85.0%,
  retrieval misses 123 to 98, multi-hop evidence reach 46.5% to 55.3%.
- **Benchmark: `--snapshot` and `--retrieve-only`.** A run can keep each
  conversation's ingested database and later runs answer on a copy of it,
  so a retrieval change is measured without extraction noise and without
  paying for extraction again. `--retrieve-only` measures evidence reach
  with no answer calls. See docs/benchmarks.md.

## 0.232.348: client v0.6.179 (client logins C6)

- Pairs the client at jackdaw v0.6.179, the client half of 0.232.346/347.
  Clients get Apps beside Shared with you and My requests: the apps an admin
  set to client level, run in the sandbox. An informational app says so to
  members and clients; an admin marks an app informational on its page. The
  admin's client thread panel shows only the client thread.

## 0.232.347: C6, released

- The release of 0.232.346 (client apps and finish). The 0.232.346 tag built
  no image and published no contract: one route test warmed its route
  imports in parallel, which raced its auth mock in CI. The imports now run
  one at a time. No product change.

## 0.232.346: client apps and finish (client logins C6)

- **Clients run apps set to client level** (`/api/client/apps`, the frame,
  the tool and db brokers; the member routes' twins): read AND write, with
  every call logged with the client login. Never a team, admin or public app
  (the same 404). The frame ticket carries the client's session epoch, so End
  sessions stops a running app at once. App tools for clients: only the
  client read tools (redacted), declared by the app and held by a client-level
  group; no requiresConfirm, spending or owner-only tool.
- **Apps are shared workspaces** (Jason, 2026-09-30): members write apps at
  team AND client level, clients write client-level apps, unless an admin
  marks the app informational (`dataReadOnly`, migration 0198; owner PATCH
  /api/apps/:id). Only admins create or change apps.
- **Client-written app data counts for the lowering guard**: a table exported
  from a client-level app is client-sourced.
- **Finish:** an accepted item carries nothing from the live node to its
  author (tables and drawings redacted too, live summary, tags and app link
  dropped); the member files route serves an accepted file under its accepted
  name; `?scope=client` on the owner comment route; chat reply images point at
  the reader's own file route or are dropped. Docs: security.md 5a,
  access-levels.md 8, sharing.md 4a, member-logins.md 14, client-logins.md 10.

## 0.232.345: the benchmark judge always gets its verdict out

- **No more cut-off verdicts.** The benchmark's judge sometimes stopped
  before writing its CORRECT/WRONG label, which counted a right answer as
  wrong (7 of 762 in one run). It now has room for a long reply and asks once
  more when no verdict can be read.

## 0.232.344: client v0.6.178 (client logins C5)

- Pairs the client at jackdaw v0.6.178, the client half of 0.232.342 and
  0.232.343. Clients get My requests (their pages, notes and uploads, with
  Submit, Recall, the Returned banner and the review talk) and a comment
  thread on every item shared with them. Members get Client requests in
  their one list and the thread on client-level Library items. Admins get
  the thread on client-level items, and Team admin > Clients shows client
  comments and client storage. Threads are paged and show no remote images;
  a client never reads the word "admin".
- A client's item a reviewer holds answers in the client's words ("a
  reviewer"), never "admin".

## 0.232.343: client tier audit fixes (C2 to C5)

All findings of AUDIT: client logins C2 to C5 (leak paths 7, integrity 6.5,
UI 7 of 10; no Blockers). Migrations 0195, 0196, 0197.

- **An accepted item is redacted for its author.** A reviewer's edits made
  after Take over no longer show a client (or a member) the titles of items
  above their level; search, a held item's title and an accepted file's name
  come from the snapshot, not the live item.
- **The client chat's tools are fixed in code.** A client turn gets only the
  client tools plus read_result, whatever the tool groups say; an agent
  changing a group below admin goes to Pending; the reconcile resets
  client-read.
- **The lowering guard checks the target.** In a turn that read
  client-written text, every write to an item at client or public level,
  and every lowering, waits in Pending; every write tool is classified (a
  sweep fails on a new one). The mark lasts 24 hours per conversation,
  follows nodes the turn creates, and scans every id. Client requests stay
  out of the corpus map. The MCP surface is documented as not gated.
- **Abuse limits.** 100 comments a day per client login (a ledger), 1000 per
  thread, paged threads; page and note text count toward the 200 MB and 5 GB
  client limits (500 KB a page, 50,000 characters a note); an 8 MB JSON body
  ceiling (64 KB on auth routes); the item cap takes the quota lock; give
  back checks the client limits; client_request_create counts a ledger.
- **Admins see clients' storage and comments**
  (`/api/team-admin/clients/storage`, `/comments`, delete a client's
  comments); the total is `MANTLE_CLIENT_SPACES_TOTAL_BYTES`.
- A deleted client's item keeps the Client badge and the client-level
  confirmation at Accept.

## 0.232.342: client drafts, requests and comments (client logins C5)

- **Clients write their own pages and notes and upload files** in their own
  space, submit them for review and recall them (`/api/client/space*`), with
  My requests as one list (`/api/client/items`) and their accepted items
  (`/api/client/accepted/:id`). Lower caps than members: 20 MB a file,
  200 MB a client, 50 MB a day, 500 items, 10 submissions a day, 50
  waiting, and 5 GB for all client spaces together.
- **Members read clients' submitted items** as Client requests (decision
  5 B), read only, through row security that needs a member's own request.
- **Comment threads on items shared with clients** (decision 8): the team,
  admins and every client login read and write them. In a client's own
  space the client reads only the reviewers' comments and their own.
- **An item accepted from a client counts as client-written** for the
  lowering guard, even after the client login is deleted.
- Migration 0194. See docs/client-logins.md section 9.

## 0.232.341: memory benchmark experiments

- **Benchmark runs can change retrieval limits.** `bench:memory
  --memory-config='{"chunk_limit":20}'` runs with the retrieval limits a
  real brain's agent carries, so a setting that scores better can be applied
  to a brain as it is.
- **The benchmark's answer prompt may infer.** The default answer prompt now
  reasons from what the memory says ("would she...?") and answers "not in the
  memory" only when nothing in it bears on the question; the strict prompt of
  the first runs stays available as `--answer-prompt=strict`.

## 0.232.340: memory benchmark fixes

- **Big benchmark results no longer crash the run.** With every answer's
  context saved, a conversation's result runs to megabytes; handed over on
  stdout it was cut off when the child exited. It is now written to a file,
  and one failed conversation is logged and skipped instead of ending the run.
- **The evidence check counts only what retrieval brought.** The corpus map
  lists every note title, and a benchmark brain has only a few dozen notes,
  so every answer-holding session always looked "found". The check now reads
  the retrieved blocks only.

## 0.232.339: the memory benchmark says why an answer was wrong

- **Each benchmark answer keeps its evidence.** `bench:memory` now saves
  the exact memory context every answer was given, checks whether the
  conversation sessions that hold the answer reached that context, and
  notes when the answer said the memory lacked it. The report splits wrong
  answers into retrieval misses (the right session never arrived) and
  answer misses (it arrived; the answer was still wrong), with evidence
  recall per question type. See docs/benchmarks.md.

## 0.232.338: client v0.6.177

- Pairs the client at jackdaw v0.6.177, the client half of 0.232.334 (one
  item list for members and admins). Every list screen uses one list kit
  with the state as a pill: the admin lists show private items beside the
  brain's (no Brain / Private switch), the member workspace is one list,
  and a client's "Shared with you" is the same list as every other screen.

## 0.232.337: client v0.6.176

- Pairs the client at jackdaw v0.6.176, the client half of 0.232.336
  (client logins C4). A client opens a chat dock from "Shared with you" and
  talks with the client-responder: the thread polls every 3 seconds while a
  reply is on its way and every 30 seconds while open, never while closed;
  a refused send says why in plain words (chat not open, too fast, today's
  limit). Team admin > Member chats filters All, Members or Clients and
  marks client rows; Requests marks a request from a client; Team admin >
  Clients shows each client's chat use today against the caps.

## 0.232.336: client logins C4, client chat

A client chats with the brain's client-responder in the client portal. Pair
it with jackdaw v0.6.176 (the client chat dock, a Clients filter on Member
chats, each client's chat use in Team admin > Clients). No migration.
Operator guide: docs/client-logins.md section 8.

- **Every brain gets client-responder, at client level.** The system
  manifest ships the agent and its `client-read` tool group at client level:
  fresh installs at onboarding, existing brains on the boot reconcile. No
  setup step. The reconcile converges `client-read` back to client; the
  agent's level stays the admin's.
- **The chat reads what the portal shows.** `client_shared_list`,
  `client_shared_search` and `client_shared_open` serve the portal's
  redacted items ("Private item" for anything a client may not read); the
  client's own drafts through `my_items_list` and `my_item_open`; no
  brain-wide search and no retrieval context (their chunks, facts and
  summaries were built from text that can name team items).
- **Client level, twice.** The agent must be exactly at client level (the
  route and the engine refuse any other), and the whole turn also runs
  inside `withViewer('client')`. The member chat now takes exactly a
  team-level agent. A spilled tool result is readable only by the client or
  member turn that wrote it.
- **Requests.** `client_request_create` files a "from client" request in the
  Requests queue (3 per message, 10 a day), extract-exempt until an admin
  acts; the admin's reply reaches the client's thread.
- **Client-written text cannot lower anything.** In a turn that read a
  client request or a client's thread, `access_set` to client or public, a
  share link or `email_page` with a link waits in Pending. Delegated
  children share the mark.
- **Owner-only tools refuse a missing surface.** They run only for the
  owner's web and Telegram turns and the owner paths that name themselves
  (MCP, runs, delegated children, approved pending calls, the dev console);
  a team or client turn, or a caller with no surface, is refused. A
  sweep pins the owner-only set and every owner call site.
- **Caps and queue.** The member caps per client login, taken from the turn
  ledger when queued; client turns run on their own queue (`mantle.client`),
  one per login at a time, `MANTLE_CLIENT_TURN_CONCURRENCY` (default 2). A
  turn queued before a sign-out, End sessions or Disable never runs.
- **Admin.** `GET /api/team-admin/clients/usage`: each client login's chat
  use today against the caps.

## 0.232.334: client v0.6.175

- Pairs the client at jackdaw v0.6.175, the client half of 0.232.333 (the
  C2/C2b audit fixes). The client portal never shows a summary, shows tables
  as the grid only, opens readable mentions in place and offers embedded
  files as downloads, refreshes on each poll, and uses the site name, never
  the peer name. Sign-in and invite pages read the code from the fragment
  (old `?code=` links still work), strip it at once and send no Referer;
  on a split-origin address client sign-in says it is not available. Team
  admin > Clients previews a sign-in sender and its Sent folders before it
  is chosen, shows delivered, failed, cap skips and whether an email worker
  runs, asks before a new link revokes an open one, and closes the link
  dialog only on Done or Copy. Member chats and accepted items name a
  client as a client.

## 0.232.334: one item list for members and admins

The brain side of the item-list alignment: a member's screen for a kind and
an admin's brain lists can now show everything the reader may see in ONE
list, each row with a small state pill, instead of hiding items behind
source switches. The jackdaw screens follow. Operator notes:
docs/member-logins.md section 13.

- **`GET /api/member/items?kind=&q=&state=&page=`.** A member's own items
  (with the ones an admin took over), teammates' shared drafts, the Library,
  and their accepted items above the Library's levels, merged newest first.
  Each row names its `source` and wears its `pill` (`private`, `draft`,
  `submitted`, `returned`, `with-admin`; brain rows none). Every source is
  read under its own rules exactly as its own route reads it; the route only
  merges. `state` narrows by pill, `brain` or `by-me`, pushed into each
  source's own query, so paging and `total` stay exact. Pages stop at 100.
- **`?state=brain|private|all` on the admin lists** (`/api/pages`,
  `/api/notes`, `/api/tables`, `/api/draws`, the files root and Recent).
  `brain`, the default, is the list as before. `all` merges the acting
  admin's own private items in the list's sort order as
  `AdminPrivateListRow` rows; `private` lists them alone. None under a tag,
  in a sub-page level or outside the files root.
- **Contract:** `MemberItemRow`, `MemberItemsPage`, `MemberItemSource`,
  `MemberItemPill`, `AdminPrivateListRow`; `MEMBER_ITEM_FILTERS` and
  `ADMIN_LIST_STATES` in `@mantle/client-types/member-kinds`; space rows
  carry `createdAt`.

## 0.232.333: client logins, fixes from the C2/C2b audit

Every finding of the C2/C2b audit (2026-09-29, 28 findings) is fixed. Pair
it with jackdaw v0.6.175: new sign-in and invite links carry the code in the
fragment, which only that client reads. Migration 0193. Operator guide:
docs/client-logins.md.

- **No summary reaches a client (B1).** The client list and reader no longer
  send `summary`, which the extractor wrote from the unredacted page text.
  Client and public pages now store only text their level can read: embeds
  the level reads, and "Private item" for mentions, links and child cards of
  anything else. A level change re-folds that text by SQL only (no
  extraction). Summaries and chunks refresh at the next commit.
- **Client tables are the grid only (B13)**, and cell refs to items a client
  cannot read show as "Private item". Every refused reference is hidden
  (external images too); scheme case and own-host URLs no longer slip past
  the redactor; readable labels show current titles; the drawing SVG drops
  links to hidden items and is rate limited (B25).
- **Members open public items by id again (B10).** A public item is open to
  anyone. The Library list stays team and client.
- **Email codes (B2, B3, B17 to B21).** Send caps are per email plus address
  (3 an hour, 5 a day), 20 a day per login (an address the client signed in
  from before is exempt), 200 a day brain-wide; IPv6 counts by /64. Every
  send records its outcome; Team admin > Clients shows delivered, failed,
  the last failure, cap skips and whether an email worker runs (codes are
  off without one). Verify does the same work on every branch. Codes are
  stored as an HMAC; open codes at deploy stop working. A plain-SQL
  `client-codes-reap` sweep clears old rows and addresses.
- **The sign-in sender (B4, B19)** is previewed before it is chosen, refused
  without a Sent folder, and choosing None or another sender restores the
  folders it excluded. Mail sync skips code mails and replies to them, and
  blanks sign-in link codes in ingested mail.
- **Sign-in links (B11, B12, B14, B15, B16).** No brain-wide failure cap
  (Jason's decision); the per-address cap stays. Links and invites use
  `#code=`; the Caddy log drops codes and Referer, and the sign-in pages
  send `Referrer-Policy: no-referrer`. Disable and End sessions revoke open
  links and codes. `/api/auth` POSTs refuse non-JSON (415) and cross-site
  (403) requests. Audit rows record the address Caddy saw.
- **Sessions (B23, B24).** Client asset tokens live 10 minutes; a client's
  Sign out ends all its sessions; `clientLoginActive` needs the epoch.
- **Restore (B22)** revokes open client links and codes and lists client
  logins. **Roster and authors (B26):** clients carry their role and are
  never shown as team members; Add client refuses an email the contact does
  not own.
- **Tests (B6, B7, B8, B18, B28).** Real byte routes driven with a client
  token, the thumbnail branch, row-lock races, the code queue end to end,
  and two flaky or order-dependent tests fixed.

## 0.232.332: memory dates from the document, and faster extraction

- **Facts start on their document's date.** A fact that is not an event
  (someone's job, a thing they own) used to start on the day it was
  extracted, so everything imported from years back looked brand new and
  outranked its own dated events. It now starts on the source's date: an
  email's sent date, else when the note was made.
- **Relative dates land on the right day.** The extractor now works
  "yesterday", "last Saturday" and "two weeks ago" out from the date the
  document was written, instead of stamping the event with that date. A
  vague time ("last week") is written against that date instead of guessed
  to a day.
- **Extraction makes fewer embedding calls.** A note's entity names are
  embedded in one call instead of two per new name. A provider key's
  throughput is capped under steady load, so fewer calls means faster
  extraction: 30% fewer calls and about 10 to 20% less time on the benchmark
  conversation, with the same facts and links.
- **Benchmark harness:** `--ingest-only` (extract, ask nothing, about $0.03
  per LoCoMo conversation) and an event-loop delay reading per run.

## 0.232.331: duplicate writes answer 409 again

- **A duplicate now answers 409, not 500.** Drizzle wraps every Postgres
  error from its query builder: the message is only "Failed query: ...",
  and the error code sits one level down, on `cause`. Code that looked for
  "duplicate key" or a constraint name in the message, or read `.code` off
  the top, never matched. So creating a login with a taken email, a key
  with a taken label, or an agent, skill, tool, tool group, worker group,
  heartbeat, model pool entry, docs collection, file or folder with a taken
  name answered 500 instead of 409.
- **Folder races no longer fail the call.** Nine "create the folder unless
  a parallel call just did" paths (generated images, video, API docs,
  sandbox exports, member review, folder paths) meant to ignore the
  duplicate and carry on. They threw instead.
- **The rfc_message_id backfill counts a duplicate as a collision** again,
  instead of logging it as an error.
- One shared check in `@mantle/db` now: `isUniqueViolation(err)`,
  `pgErrorCode(err)` and `pgConstraint(err)` walk the cause chain. The
  three private copies are gone. A database test pins what drizzle throws,
  so an upgrade that changes the wrapping fails there first.

## 0.232.330: memory benchmarks, and entities no longer lost to a race

- **A benchmark harness for the whole memory path.** `pnpm -C server/api
  bench:memory` runs LoCoMo and LongMemEval through the real brain: each
  conversation goes into its own scratch database as dated notes, the
  shipped extractor processes them, the responder's retrieval answers each
  question, and the published judges grade it. Manual runs only, with a cost
  estimate and a hard spend cap. First smoke run (one LoCoMo conversation,
  20 questions): 80%, at about 5.4k tokens of context per question.
  Runbook: docs/benchmarks.md.
- **Parallel extraction no longer drops entity links.** When two documents
  being extracted at the same time both named a new person, the second one
  lost its link to that person (a unique-violation handler never matched
  the wrapped database error). It now reuses the entity the first one
  created. The benchmark found it: 5 speaker mentions across 19 notes.

## 0.232.329: client v0.6.174

- Pairs the client at jackdaw v0.6.174, the client half of 0.232.328 (old
  client links retire). Team admin > Shared links lists the retired client
  links under the live ones: each item, its level now, how often the old
  link was viewed and when last, and when it retired, with a pointer to
  Clients to add the people who used them. A retired link has no Copy and
  no open action: it answers "Sign in as a client" now.

## 0.232.328: client logins, phase C3 (old client links retire)

Before client logins, "client" meant "anyone with the link". Clients sign in
now (C2, C2b), so the old links retire (decision 4 A).

- **Migration 0192** revokes every link on an item at client level, an
  expired one included, and marks it `settings.retired = 'client'` (a link
  revoked earlier without the mark gets it too, keeping its revoked date).
  Every item keeps its level; links on items at other levels are untouched.
  On every box counted before the roll to 323 there were no such links.
- **/s answers an old client link with 410 "Sign in as a client"**: no item
  title, a Sign in button to `/client-signin`. The public link routes never
  serve a link on a client item, even one the migration did not reach, and
  a retired link stays retired if its item later leaves client.
- **Every link is public**: a folder or page link shows public items only
  (`linkLevels`).
- **Shared links** (Team admin) lists the retired client links, without a
  token: title, level now, views, last view, retired date.
- From C2b: `GET /api/auth/client-code` fails closed (codes off, never a
  500) when the sender cannot be read; the code routes join the public
  session sweep.

## 0.232.327: keyword search finds the rare words in a chat question

- **The keyword half of hybrid search works on real questions.** It used to
  need a passage that held every word of the message, so it matched almost
  nothing on a chat turn (4 of 35 recent turns on dev). It now searches the
  rarest words of the message, ORed, and ranks the rows that hold the rarest
  ones first. On the same turns: 33 of 35 get keyword hits, and a task id
  buried in a long question now ranks its passages first. Applies to the
  responder's automatic passages and to the `search` and `search_chunks`
  tools. No model call; a short query of common words keeps the old
  behaviour. Idea from the Hindsight memory engine's term selection.

## 0.232.326: client v0.6.173

- Pairs the client at jackdaw v0.6.173, the client half of 0.232.324 and
  0.232.325: sign-in by an emailed code. /client-signin without a link asks
  for the email, then for the 8-digit code (paste friendly), with the same
  neutral words for every email ("If this email has a client login, we
  sent it a code"), Send a new code and Use a different email. The option
  shows only when the brain sends codes; otherwise the page says to ask the
  admin for a sign-in link. /login has a quiet line for clients. Team admin
  > Clients has a "Sign-in codes by email" card: pick the sender (or none),
  see the sent folders kept out of the brain, and a banner when the daily
  limit is reached.

## 0.232.325: client email codes, asking again

- **Asking again no longer strands the mailed code.** A browser that asks
  for a code again ("Send a new code", a double click) keeps its request
  id, so the code already in the inbox still works there; no second mail
  goes out while it is open. Once that code is used, dead or expired, the
  same browser gets a new one. Found by the jackdaw C2b build: before, the
  second request set a new request id and the client was stuck for up to
  10 minutes.
- **One browser, two emails.** "Use a different email" gets a code for each
  email, and each code redeems only with its own email. A wrong email finds
  no code (it no longer costs another email's code a try).

## 0.232.324: client logins, phase C2b (email sign-in codes)

A client who has no sign-in link can ask for a code by email, when an admin
has chosen a sign-in sender (Team admin > Clients). Codes stay off until then.

- **No oracle.** `POST /api/auth/client-code { email }` answers 200 with a
  fresh request cookie for every email and every body, and does the same
  work each time: it only queues the request. The email-sync worker looks
  the email up, applies the caps, stores the code and mails it (plain SMTP
  from the chosen account: no agent, no LLM).
- **The code.** 8 digits, 10 minutes, one use, 5 wrong tries counted in the
  database, stored only as SHA-256 of the request id and the code, and
  tied to the browser that asked: `POST /api/auth/client-code/verify` needs
  that browser's request cookie, so a forwarded code opens nothing. Every
  failure is the same 401. Success sets the 30-day client session.
- **Limits.** No new code while one is open for the same email and address;
  5 codes a day per email and address, 10 an hour per email, 200 a day for
  the brain (then nothing is sent and Team admin says so). Failed tries are
  limited per email plus address; there is no brain-wide failure lockout.
- **Codes never enter the brain.** Choosing a sender leaves its sent-mail
  folders out of mail sync, and every code mail carries a Message-ID marker
  that the sync skips in any folder (a provider's All Mail too).
- Migration 0191 adds `request_ip` and two indexes to `client_signin_codes`.

## 0.232.323: client v0.6.172

- Pairs the client at jackdaw v0.6.172, the client half of 0.232.322 (the
  C0/C1 audit fixes). The app shell keeps failing closed when /api/shell
  fails, but now retries by itself (2, 4, 8 s, then every 15 s), treats an
  offline probe as failed, and offers Sign out on every neutral screen.
  "What clients see" acknowledges by the fingerprint of the whole set,
  shows "New since checked" only after a check, names old links above an
  item, and never shows the title of an item outside the brain. The Access
  popover can revoke an old client link on the item (it stays at Client),
  names old links above it, and keeps the old copy on brains before C1.
  Shared links reads each link's level from Team admin and hides Copy on
  old client links. The review dialog shows the author's role, starts a
  client's item at Team, and at Client or Public asks for a tick on every
  item that goes down. Reset password shows for admin and member rows only.

## 0.232.322: client logins, fixes from the C0/C1 audit

Every finding of the C0/C1 audit (2026-09-29, 32 findings, none a leak to a
client) is fixed. Migrations 0189 and 0190; 0186 and 0187 gain a lock
timeout.

**Roll note (boxes on v0.232.315).** 0186 to 0190 land together. No manual
step. Admins will see: the Access popover with no link box at Client, level
badges in Shared links, the "What clients see" tab, needs-you notices, and
the share tools refusing a client item (`client-links-retired`). Read-only
counts before a roll: `scripts/client-level-counts.sql`. Rollback floor:
never below v0.232.318 once any client login exists (older images treat
every role that is not member as an admin); from this updater on, a roll
below it is refused while client logins exist (`MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1`
overrides). The roll that brings this release still runs the old updater.

- **Restore works again (A1).** `scripts/db-restore.sh` restores into a
  pristine database. Before, the init script's `auth.users` (without
  `session_epoch`) made pg_restore skip the table: every login and the role
  CHECK were lost while the script said "Restore complete". It now exits 2
  when logins, the role CHECK or the row rules for nodes, agents and tool
  groups are missing, and prints every pg_restore error.
- **Client and public are siblings (A5).** The client role reads client
  items, agents and tool groups only (0189). A client scope never runs
  public-level work and a public scope never client-level work: refused
  (`ViewerLevelConflictError`, HTTP 403 `level-conflict`), never widened. An
  agent holds a tool group only at a level it reads.
- **Client role narrowed (A27).** `mantle_brain_id()` runs for the viewer
  and space roles only; the client role reads no embedding config and only
  `user_id, preferences` of profiles. A `read_result` spill carries its
  writer's level; a reader below it gets not found.
- **A client's items stay private (A17).** A database trigger refuses
  sharing a client's space item with the team.
- **Logins name their role (A14, A15, A16).** `auth.users.role` has no
  default (0190). Token refresh rotates admin and member bearers only.
  `withSpace` refuses a space that is not the login's own, and a disabled
  login. Admin password reset refuses a client or unknown-role target with
  400 `not-a-password-login` (member resets stay).
- **"What clients see" (A7, A8, A23, A24, A11).** Acknowledged by a
  fingerprint of every client item (409 `report-changed` when the set moved),
  so a brain with more than 2000 client items can be acknowledged. A ref to
  an item outside the brain shows no title. Email hints count finished
  sends only (to, cc, bcc, 400 days, indexed). Drawings and tables are
  scanned for refs. Old live links above an item (a client folder holding
  it, a client page embedding it) are named, here and in the Access
  popover (`oldLinksAbove`, `openLinkLevels`).
- **Links (A9, A10, A12, A18, A19, A20, A21).** "Include sub-pages" skips
  client sub-pages in one transaction. A client embed that goes public with
  its page is called out in the tool answer. Setting client on an item
  already at client keeps its old link. `/api/team-admin/shares` carries
  each link's level. `email_page` with `includeLink` on a client page is
  refused before sending. A revoked client link is marked
  `retired = 'client'`. The refusal tells a model to ask the owner.
- **Accept (A6, A22, A28).** The review queue names the author's role. The
  Accept preview lists the embed closure; accepting a client's item at
  client or public needs every going-down item ticked (`confirmedIds`), on
  the review path and after Take over. The confirm copy is right at public.
- **The admin shell survives a broken part (A13).** `/api/shell` answers
  200 when preferences, the pending count, onboarding or the asset token
  fail; member and client shells likewise for their brand.
- **Tests (A3, A4, A31).** Session-reading public routes are driven for
  every role from one table (`public-session-routes.ts`) with a completeness
  check; a fast unknown-role check; a real team-delegation DB test;
  non-circular client grant facts; CI fails when a database test URL is
  missing; the admin-space count no longer races client submissions.

## 0.232.321: client v0.6.171

- Pairs the client at jackdaw v0.6.171, the client half of 0.232.320: the
  client portal. A client opens the sign-in link, types their email and
  lands on "Shared with you": the items at client level, newest first, by
  kind, with read-only viewers and downloads. A reference the client may
  not read shows as plain "Private item". The client chrome shows the brand
  name only, with Sign out and Sign out everywhere; the portal polls, so an
  ended session goes to sign-in on the next poll. Team admin > Clients adds
  client logins, issues sign-in links (shown once, with copy), revokes
  them, ends sessions, disables and deletes; Add client and Issue sign-in
  link stay disabled until "What clients see" is acknowledged. Settings >
  Logins shows the role Client. The member Library marks client items with
  a Client badge.

## 0.232.320: client logins, phase C2 (client logins and the portal, read)

Clients can now sign in. An admin adds a client login in Team admin >
Clients and hands the client a sign-in link. A client reads the items set to
client level, and nothing else.

- **Client logins and sign-in links (migration 0188).** Add client and Issue
  sign-in link are refused (409 `report-not-acknowledged`) until an admin
  has acknowledged "What clients see", and again once a new item goes to
  client. A client login is made with role client and a password nobody
  knows: password sign-in, a mobile bearer and pairing never open it. A
  sign-in link lives 72 hours, is one use, is stored only as its SHA-256,
  and asks the client to type their email as a check; a new link revokes
  the older one. `POST /api/auth/client-link` answers every failure with
  the same 401 and is rate limited per address and, on failures,
  brain-wide. End sessions, Disable and Delete are the users routes.
- **Client sessions last 30 days**, bound to the login's session epoch. A
  client cookie that claims to last longer is refused.
- **Deny by default.** A client reaches only the routes in
  `CLIENT_ROUTES` (`GET /api/client/shell`, `shared`, `shared/:id`,
  `files/:id`, `draws/:id/svg`); every other route refuses it, and admins
  and members are refused on these. `client-sweep.test.ts` and
  `role-sweep.test.ts` drive every route.
- **The client portal, read only.** "Shared with you" lists the items at
  client level, read at the client level. A reference in a page or note to
  something a client may not read shows as "Private item" with no target;
  an embed of one is left out. Client answers carry no staff or author
  names. The client polls; there is no live stream for clients.
- **Members see what clients see (decision 6).** The member Library lists
  team AND client items; each row carries its level.
- **Mail gates (decision 10).** A client login's email passes the email
  gates only when the client is also a contact.

## 0.232.319: client v0.6.170

- Pairs the client at jackdaw v0.6.170, the client half of 0.232.318: the
  app shell knows three roles and fails closed (a neutral loading screen
  until the role is known, never the admin chrome by default; a client
  login sees a plain "client portal not available yet" card with Sign out).
  The Access popover says Client is "Signed-in clients (and the team)" with
  no link box (Public keeps its link). Shared links show each link's level
  and mark old client links. Team admin > "What clients see" lists every
  client-level item and records the acknowledgement.

## 0.232.318: client logins, phases C0 and C1 (the client level, dark)

No client login can be made yet (the users API refuses role client until
phase C2). What changes for an admin today: **client no longer means "anyone
with the link"**. It means signed-in clients, and public is the only level
with an open link.

- **Three login roles, fail closed (C0).** A login is an admin, a member or a
  client. The session code names each role; a role it does not know is no
  login at all (before, every role that was not member resolved as an
  admin). Every admin and member gate refuses a client with 403
  `client-login`. Password sign-in, an admin password reset, change
  password, a personal assistant and MCP consent refuse a client; a role
  change to or from client is refused. `role-sweep.test.ts` drives every
  route with a client login and with an unknown role. Contract types
  `LoginKind`, `LoginRefusedReason`, `LoginRefused`.
- **The client level in the database (C1, migration 0187).** The role CHECK
  admits client. The client role reads client items only, not public ones
  (decision 3), on every search arm. It reads agents and tool groups at
  client level and below only (the team role keeps every row), and holds no
  grant on logins (`mantle_brain_id()` is SECURITY DEFINER). The access
  matrix is per role. Proven on a copy of the dev brain: no leak on any arm,
  client searches 1 to 5 ms. The team-drafts read rule stops early now
  (it called the brain id once per hidden row).
- **No client links.** Setting an item to client removes its open link. A
  link on a client item is refused (`client-links-retired`) inside
  `createShare`, so `node_share`, `page_share`, `POST /api/shares`, the
  email link and the sub-page cascade all meet it. Old client links stay live
  until phase C3 retires them, and no re-sync moves their item. Turning an
  old client link off keeps the item at client. `/api/shares/all` shows each
  link's level. Contract type `ShareRetiredReason`, `SharedLinkRow`.
- **"What clients see"** (`GET /api/access/client-report`, `POST
  /api/access/client-report/ack`, table `client_report_acks`): every item
  at client level, its old link and views, the addresses a page was
  emailed to, and the team or admin items it names. Adding a client (C2)
  waits until an admin acknowledges it. Contract types `ClientReport*`.
- **Client spaces.** `withSpace` takes its level from the login's role
  (client for a client). A client draft may name only its own items and
  client items. Accept of a client-authored item defaults to team; client
  or public needs `lowerConfirmed` (409 `confirm-level`). Give back after
  Take over checks the item at the author's level.

## 0.232.317: client v0.6.169

- Pairs the client at jackdaw v0.6.169, the client half of 0.232.316: a live
  "N waiting for review / N open requests" notice at the top of the rail, a
  toast when something arrives, the tab title "(N)" and a favicon dot, an
  opt-in browser notification (profile menu, per browser), and in the desktop
  app the dock badge, a dock bounce (macOS) or taskbar flash (Linux) until
  focused, and a native notification that opens the item.

## 0.232.316: admins are told what waits for them

- **"Needs you" live event.** Migration 0186 raises `needs_you_changed`
  (payload: the brain's owner id) from triggers whenever something starts or
  stops waiting for an admin: a member submits or recalls, an admin returns,
  accepts, takes over, gives back or discards, a login is deactivated or
  reactivated, a team request is filed, done, reopened or deleted. Saves,
  shares and edits never fire it. Notify-only: nothing listening starts LLM
  work (a test pins the two listeners).
- **`GET /api/team-admin/needs-you`** (admins only): the Review queue
  (submitted, left behind) and open requests as counts, plus the newest of
  each by title and author, never content. The owner live stream sends
  `needs_you` when they may have moved. Contract type `NeedsYou`.
- **Phone push** to active admin devices only (never a member's, a
  deactivated admin's or an unattributed device), once per arrival, title
  and member name only; follows the approvals toggle.
- The Requests badge counts with a count query (it stopped at 100).
- Scratch test databases get the access matrix grants, as migrate gives them.
- The client half (rail notice, toast, tab title and favicon, browser
  notification opt-in, desktop dock badge and bounce) ships in the next
  client release.

## 0.232.315: client v0.6.168

- Pairs the client at jackdaw v0.6.168: the Access popover says how many
  embedded items will be shared too before you confirm a lower level, and
  shows what went down with the item afterwards. Also the client halves of
  0.232.310 to 0.232.313 (agent delete keeps or deletes the conversation,
  onboarding purpose limit and Memory "Runs via" default).

## 0.232.314: embedding means sharing

- **An item's embeds follow it down.** Lowering a page, drawing or note below
  admin (the Access control, `access_set`, `node_share`, `page_share`, a share
  link, the accept level) is one admin decision for the item and what it
  embeds: images, files, drawings and child pages go down with it, in the
  same transaction. Nothing is ever raised, an embed already lower is left
  alone, and a kind that can never leave admin is reported (`stillAbove`).
  Answers carry `alsoLowered`. Folders keep their own rule: a folder's
  contents do not follow it.
- **Later embeds follow on save.** A new embed saved into a page, drawing or
  note below admin takes that level. One an admin raised on purpose stays
  raised.
- **Pages lowered before this release** get the same decision applied once
  per brain on first boot (a marker keeps it from running again).
- **Share links serve by level.** A page or drawing link serves an embed only
  at the link's level, so an embed an admin raised back to admin leaves the
  link.
- The Access popover says how many embedded items will be shared too before
  you confirm (client release after this one).
- `scripts/roll.sh` checks the updater's pre-roll backup line as one quoted
  phrase (it failed every check on a box whose updater takes the backup).

## 0.232.310 to 0.232.313: files, agents and onboarding

Tagged together with 0.232.314 (these releases were not tagged on their own).

- Deleting a folder no longer removes files on disk that the brain does not
  track.
- A file name is unique per folder, not per brain.
- Deleting an agent can keep or delete its conversation.
- Onboarding refuses an over-long purpose instead of trimming it.
- Model pool prices round, so onboarding cards stop showing float noise.

## 0.232.309: the client with the audit fixes and Take over

- Pairs the client at jackdaw v0.6.164: Take over and Give back in Team
  admin > Review and the Private view, "With admin" for members, the
  accepted snapshot notice, "Sign out everywhere" (account menu, and each
  login's Devices card in Settings > Users), member citation links that open
  from any source, the admin reply to a member's request, and the error
  states the audit listed.
- `scripts/roll.sh` no longer reads a fleet box's url as its stack dir when
  the box has no `stack` field.

## 0.232.308: final audit fixes for member logins, and Take over

Fixes every finding of the final member-logins audit (F01 to F31). Migrations
0180 to 0183. Roll web and api together, refresh compose (new env names), and
take the first roll with `scripts/roll.sh` (the box still runs the old
updater, which takes no backup). Never roll back below this release once
0183 ran without giving back or accepting taken items first.

- **PDF and drawing renders no longer carry a session (F01).** The render
  sidecar gets its own short `render` cookie for the acting admin and one
  node, set on the print origin only; every request to another origin is
  aborted, and `/print` sends a strict CSP. An outside image in an exported
  page used to receive the anchor's live session.
- **Take over (F07).** An admin can take a submitted member item (and its
  bundle) into their own private space, correct it out of the member's
  sight, then accept it into the brain (the extractor runs once, on the
  corrected version) or give it back with a note. The member sees "With
  admin" meanwhile. Every Accept now stores a snapshot for the author: a
  member reads what was accepted, never later admin edits.
- **The submitted bundle is frozen (F04).** Submit records the bundle and
  refuses unsaved bundle drafts; its items stay frozen until a decision, and
  Accept moves exactly that bundle.
- **Safe deletes (F03, F18, F21).** Purge and Discard delete only rows still
  in the space and lock like Accept; the purge keeps anything a shared or
  submitted item embeds; a deleted login's space is purged after 30 days
  and no longer counts as a member's; promotion to admin turns shared and
  submitted rows back into private drafts.
- **Sessions can be ended (F06).** A signed session epoch (0181) ends every
  session and bearer on password change, disable, role change, and the new
  "Sign out everywhere" (`POST /api/auth/logout {everywhere:true}`,
  `PATCH /api/users/:id {signOut:true}`). OAuth codes and web-token
  refreshes are claimed atomically; a login for an unknown email takes the
  same time; one login per contact is a unique index.
- **Member chat cost (F08, F09, F17).** A turn ledger at enqueue (0182) holds
  the daily cap, plus a daily token budget per login
  (`MANTLE_MEMBER_DAILY_TOKENS`), on a member queue of its own
  (`MANTLE_MEMBER_TURN_CONCURRENCY`). Member change requests are capped and
  reach no model until an admin acts. Member apps never call a built-in that
  spends. Member writes are rate limited and NUL-stripped.
- **Rolls (F02, F15, F16).** The updater takes a strict four-part backup
  before every roll and refuses the roll when it fails, then prunes old
  server and client images (never sandbox images). New `scripts/roll.sh`
  with the apps, sandboxes and app-db count guard.
- **Links and levels (F19).** A shared folder lists and serves only items at
  or below the link's level.
- **Smaller items.** `TeamRequest.loginId` (admins can reply to member
  requests), `used_private` backfilled, re-embed skips archive pages, a
  recovered team turn no longer sees its message twice, audit paths and
  my-space traces drop personal item ids, SECURITY DEFINER functions are
  not PUBLIC, `linked` removed from the member chat answer.
- **Tests and docs.** The team-agent level rule, the member realtime filter
  and the RLS owner check have tests that run in CI; drop-table tests use
  their own database; security.md, access-levels.md, member-logins.md and
  update-prod.md match the code.

## 0.232.307: the installer survives a dropped image download

- `scripts/install.sh` retries a failed `docker compose pull` three times
  (10s, then 20s). One reset connection to a registry used to abort the
  whole pull, and the `up` after it created only some services. If every
  attempt fails, the installer now stops before `up` and prints the exact
  command to re-run. A re-run is safe. The client image pull retries too.
- The owner UI step first checks that the server network (`mantle_default`,
  read from `docker-compose.client.yml`) exists. If it does not, the step is
  skipped with a clear message instead of compose's "declared as external,
  but could not be found".
- `scripts/install.sh --check` no longer calls Caddy's own HTTP to HTTPS
  redirect for the configured site address "not Mantle". It names it as the
  redirect. Other output is unchanged.

## 0.232.306: sandboxd negotiates the Docker API version

- sandboxd no longer pins Docker Engine API 1.43. Docker 29.0 and 29.1
  raised the daemon's minimum to 1.44, so every sandboxd call failed,
  `/healthz` answered 503 and a fresh install ended "Installation
  incomplete". sandboxd now asks the daemon's unversioned `/version` once
  and keeps 1.43 inside the range the daemon accepts (1.44 on Docker
  29.0/29.1). If Docker is not up yet, it asks again on the next call.
- `scripts/install.sh` preflight notes a raised Docker API minimum, since
  an older pinned `--image-tag` still carries the 1.43-only sandboxd.

## 0.232.305: Phase 6 compatibility fields removed

- The fields Phase 6 kept for one client cycle are gone (every box runs
  client v0.6.162 or newer): `TeamMemberActivity.tokenLastUsedAt`, the
  hub-app `modeChanged` (the answer is `{ appId, levelChanged }`),
  `membersEnabled` on `GET /api/users`, and the forum parts of the Team
  admin answers (upload badges and lists, `dashboardTags`, member `forum`
  and forum post paging). The unused frozen `Forum*` types leave
  `@mantle/client-types`.

## 0.232.304: client v0.6.163

- Paired with jackdaw v0.6.163: the client no longer reads the retired
  one-cycle fields (the hub-app `modeChanged` fallback and the forum badge
  types are gone).

## 0.232.303: member file links take an asset token

- The gate admits a member's `?at=` asset token on the member space byte
  routes (`/api/member/space/:id/bytes`), as it already did for admins.
  Another member's file is still a 404 in the token's own space, and a token
  from another brain is a 401.

## 0.232.302: client v0.6.162

- Paired with jackdaw v0.6.162. Team codes: the first Team admin tab is the
  Chat archive (contacts with old portal chat; Invite as member stays), the
  invite page takes invite codes only. Phase 7: a Keep private switch in New
  page, table, note, drawing and a Private upload; a Brain | Private switch
  on each list; private items open with Save version, Delete and Accept into
  brain. The client pins the contract at 0.232.301.

## 0.232.301: team codes retired (0178) and admin private items (Phase 7, 0179)

- Migration 0178 drops `contact_team_tokens` (its one FK to nodes dropped by
  name first, then the table without CASCADE). Contacts, their old portal
  chat and every other row stay.
- An old 8-character team code no longer redeems anything: only a
  16-character invite code does. Invites made before 0178 still redeem. The
  invite code's alphabet cutoff is fixed (216, not 224) so every character is
  equally likely.
- Team admin's first tab lists every contact with old portal chat (a chat
  archive), newest first. `TeamMemberActivity.tokenLastUsedAt` is always null
  (deprecated one cycle); `memberSince` is the first portal message.
  `ContactRow.team` is gone.
- Phase 7: an admin keeps items private in their own space (routes
  `/api/admin/space*`, mirroring the member ones with no share, submit,
  recall or comments) and accepts them into the brain themselves
  (`POST /api/admin/space/:id/accept`, the Team admin accept body and
  answer; no author badge). While private, an admin's item may embed any
  brain item. Migration 0179 limits the team-drafts read rules to member
  spaces, so a member promoted to admin never exposes later edits to
  members. The review queue shows only member-written items.

## 0.232.300: client v0.6.161

- Paired with jackdaw v0.6.161: Team admin no longer shows the forum Export
  banner (the brain dropped the forum tables in 0.232.299; the Forum archive
  pages stay in Pages).

## 0.232.299: the forum tables are dropped (Phase 6, migration 0177)

- Migration 0177 drops forum_topics, forum_posts, forum_uploads and
  forum_read_cursors. Their foreign keys are dropped by name first, then each
  table without CASCADE. It aborts if a topic has no Forum archive page.
  The archive pages, the files the export filed, the JSON dump and every row
  outside those four tables stay.
- The forum export goes with the tables: its api boot task, the
  `/api/team-admin/forum/export` route (now 404) and the Drizzle schemas.
  The archive pages stay admin-level and un-indexed.

## 0.232.298: client v0.6.160

- Paired with jackdaw v0.6.160, the client side of stage 6: no Revoke code
  button (its route is gone), a shared link is always public (no team pill),
  the home app toast speaks of the Team level, and /team or /hub go straight
  to /login with nothing carried (an old team code no longer rides along in
  `next`). The client pins the contract at 0.232.297.

## 0.232.297: team links retired (Phase 6 stage 6)

- Migration 0176 revokes every team-mode share link. Items keep their level:
  a team item stays at team, members read it with their own logins.
- A team link can no longer be made: `PATCH /api/shares/:id` answers 400
  `team-links-retired`, and `node_share` / `page_share` take only `public`.
  An old team `/s` link shows a "Sign in as a member" page (410).
- Removed: the team gate, `/s/[token]/auth`, the team visitor cookie, the
  contact id on share frame tickets and `/api/contacts/[id]/team`. A shared
  app's tool broker refuses every call (public apps never had tools).
- Home app designation puts an admin-level app at team instead of making a
  team link, and answers `levelChanged` (`modeChanged` stays one cycle).
- Contract: `ShareMode` is `'public'`; `DELETE /api/shares/:id` drops
  `keptTeam`; the hub-app PUT drops `shareToken`.

## 0.232.296: client v0.6.159

- Paired with jackdaw v0.6.159: the team-code portal screens (/team, /hub,
  the team workspace, the forum pages and the Team admin Topics tab) are
  gone, matching the brain's stage 5 in 0.232.295. The forum Export button
  shows only while topics are left to export.

## 0.232.295: the team-code portal is retired (Phase 6 stage 5)

- /team, anything under it, and /hub redirect to /login; /api/team/* and
  /api/team-portal are gone, with the raw team-code bearer and the signed
  team-chat credential. Team-mode /s links and contact_team_tokens stay
  until stage 6 (invites still accept an old code once).
- The forum turn runner is gone: a forum turn still queued on a box runs
  into a no-op stub under its old name and ends cleanly. The admin forum
  routes, topics, thread-read and dashboard-tags go; members, requests and
  settings keep their answer shape with the forum parts empty.
- team_member_list, team_notify and the team-notify group are retired (the
  boot reconcile disables them). The team-responder prompt is rewritten for
  member chat; it replaces a live prompt only when that prompt is exactly a
  shipped default (an edited prompt is kept; the old text stays as v1).
- An admin's reply to a request a member login filed lands in that
  member's own chat thread.

## 0.232.294: client v0.6.158

- Paired with jackdaw v0.6.158: Team admin shows a member's earlier team
  chat apart from their thread; the forum is read-only with a closed notice
  and an Export to Pages action; the team portal points code holders to
  /invite.

## 0.232.293: the team forum closes and becomes an archive (Phase 6 stage 4)

- The forum takes no new topics, replies, uploads or admin posts (410
  forum-closed, with a hint to ask for an invite); reads stay for now.
- Team admin can export the forum (POST /api/team-admin/forum/export; a
  boot task also runs it once while topics are unexported): one admin-level
  page per topic under "Forum archive", a JSON dump in files/archive,
  unreviewed uploads filed to files/review/forum-archive, requests linked.
  Archive pages are never extracted or embedded (no model cost).
- The member daily cap and dedupeFilename moved out of the forum modules.

## 0.232.292: invites in the client; old team history follows the login (Phase 6 stage 3)

- Paired with jackdaw v0.6.157: Team admin > Invites (Invite as member on a
  code holder, copy the link and code, revoke), the public /invite page, a
  notice on the old team code gate, and the Users role picker always shows.
- Migration 0175: team_access_log.login_id; a redeemed contact's access log
  and comments are linked to its member login (also at redeem time). Old
  portal chats stay with the contact: admins see them beside the member's
  thread (member-chats portalThread, team_chat_read portal_history), the
  member never does, and they never enter the model's context.
- Removing a team link keeps the item at team level (team sub-pages too);
  team_access_list filters by loginId.

## 0.232.291: members always on, member invites, app SQL in child processes

- Phase 6 stage 1: the MANTLE_MEMBERS flag is gone; member logins work on
  every brain (GET /api/users still answers membersEnabled: true for one
  contract cycle).
- Phase 6 stage 2: member invites (migration 0174, member_invites). An admin
  invites a contact from Team admin and copies the link; the person sets a
  password at /invite and lands as a member. An old 8-character team code
  works once in place of the invite code while an invite is open for that
  contact; redeeming deletes the old code. Routes: /api/team-admin/invites,
  /api/auth/invite/:code, /api/auth/invite/accept. Contract: MemberInvite*.
- App SQL runs in a small pool of child processes: a write stopped at the
  time limit no longer leaves the app's database locked until a restart,
  and statements are faster (no thread start per statement).

## 0.232.290: client v0.6.156

- Paired with jackdaw v0.6.156: member chat stops polling a reply the brain
  never finished and a retried send is run once; a member table no longer
  adds a row twice after a lost save (it reloads on a conflict); a big edit
  a reload cut off is sent on the next open; the Access popover names an old
  brain on a 404; member app and member-chats types come from the contract.

## 0.232.289: member logins, the audit's small items (session 9)

- Lockout also unpairs the login's push devices (migration 0173,
  push_subscriptions.login_id), refuses its unclaimed pairing codes and
  releases its assigned assistant. A member cannot be given an assistant.
- /api/member/files/:id streams and is rate limited per login. A drawing's
  SVG keeps only the images the member may read.
- Member chat: a reused Idempotency-Key with new text is a 409. OAuth
  authorize tells a member plainly they cannot connect.
- Unsharing (the shares route, node_unshare, page_unshare) applies the admin
  closure rule and reports what stays below admin. Level and link change in
  one transaction; an expired link no longer blocks a new one; a sub-page
  cascade never passes through public. content_supersede warns when the old
  version is still visible. 0161: the deepest shared folder wins (new
  installs; boxes keep their levels).
- An app's schema DDL runs in the SQL runner (worker, authorizer, limit).
- Contract: member app, home and member-chats DTOs in client-types.

## 0.232.287: the member's own chrome (Phase 5); client v0.6.154

- Paired with jackdaw v0.6.154: a member changes their own password from the
  account menu, gets their own tour (once, on the member home; Take the tour
  opens it again), and reads the contract banner as text with no admin link.
  A `?tour=` link to an admin tour no longer traps a member on Home.
- docs/member-logins.md section 8. No brain change: the password route
  already served every login.

## 0.232.286: member uploads with a taken name; client v0.6.153

- A member uploading a file whose name their space already holds got a 500;
  it now files as `name-2.ext` (the rule Accept uses).
- Paired with jackdaw v0.6.153: the Accepted source on each member screen,
  the author byline, and the member-authored badge in the Library and the
  admin Access panel.

## 0.232.285: what a member wrote stays theirs to read (Phase 4 "not yet")

- A member lists what they wrote and an admin accepted
  (`GET /api/member/accepted`) and reads each one's saved version at any
  level (`GET /api/member/accepted/:id`), never an admin's draft. An image
  or drawing they wrote, accepted at admin, still renders in their other
  drafts. Nobody else gets anything new (docs/member-logins.md section 6).
- The member-authored badge: the member Library and the admin Access panel
  carry `author: { name, acceptedAt }` on an accepted item.
- `@crossworks/client-types`: `MemberAcceptedRow`, `MemberAcceptedPage`,
  `MemberAcceptedItem`, `MemberItemAuthor`; `author` on `MemberLibraryRow`
  and `AccessNodeView`. Additive; older clients ignore them.

## 0.232.283: member types in the contract (audit M2, M3, S13, P2)

- `@crossworks/client-types` publishes the personal-space wire shapes
  (`MemberSpaceItemRow`, `MemberSpaceList`, `MemberSpaceFile`,
  `MemberSpaceItemBody`, `MemberSpaceItem`, `MemberSpaceSharing`,
  `MemberReviewState`) and the one member kind list
  (`@crossworks/client-types/member-kinds`: `MEMBER_ITEM_KINDS`). The brain's
  space row is that type, and compile-time checks tie its body, file and
  enums to it. No wire change.
- Migration 0168 drops each policy before creating it, so it re-runs by
  hand (run 0171 after it). Boxes that ran it are unchanged.

## 0.232.281 and the patch after it: members run apps; app SQL is hardened

- Members run team-level apps from their shell (docs/member-logins.md
  section 7): published build only, a run-only tool broker (read-only
  built-ins from an enabled team-level group), writes only to team-level
  apps, access log by login (migration 0172), the pinned hub app as the
  members' home.
- **App SQL, every caller** (share links, members, the owner, `app_db_query`):
  each statement now runs in a worker thread with a 5 second limit, 50,000
  rows and 16 MiB per string or blob at most. The engine refuses ATTACH,
  DETACH, VACUUM and every PRAGMA but `table_info` / `table_xinfo`. Before,
  a leading comment slipped VACUUM INTO past the check, and one endless
  query froze the web process. An app that ran `VACUUM` itself, or queries
  more than 50,000 rows at once, now gets an error.
- Team Chat's `app_db_list` / `app_db_query` read apps at team level or
  lower (before: apps with an active team-mode share; the same set on every
  box checked).

## 0.232.249: the object store is RustFS; boxes copy their MinIO data over once (branch feat/objectstore-rustfs)

MinIO left open source (repo archived, public images deleted, only the licensed
AIStor build left), so the bundled object store is now RustFS (Apache-2.0,
S3-compatible). The `minio` service is replaced by two:

- `objectstore_init`, a one-shot that runs before the store. On a box with
  MinIO data it copies `data/minio` to `data/rustfs` ONCE (free disk checked
  first; staged in `rustfs.partial` so an interrupted copy restarts clean) and
  records the counts in `data/rustfs.copied-from-minio`. `data/minio` is never
  touched, so updating back to a MinIO release finds it exactly as it was;
  objects written after the switch exist only in `data/rustfs`. A new box
  gets an empty store. It copies rather than moves because RustFS rewrites
  its data dir on first start.
- `objectstore` (container `mantle_objectstore`), RustFS on `data/rustfs` as
  UID 10001, `mem_limit: 1g` (a full read of a 667 MB store peaked at 293 MiB
  and a 256m cap was OOM-killed), `nofile` 65536, console off.

The image is `titanwest/mantle-rustfs:1.0.0`, a byte-for-byte mirror of
`rustfs/rustfs:1.0.0` pinned by digest in `infra/rustfs/IMAGE` and published by
the new `rustfs-image` workflow, so an upstream repo vanishing cannot break a
pull again. `RUSTFS_IMAGE_TAG` replaces `MINIO_IMAGE_TAG`; `S3_ENDPOINT` now
defaults to `http://objectstore:9000`. Dev compose runs the same (console on
127.0.0.1:9001, creds unchanged).

Tested before this release: RustFS on copies of three real boxes' MinIO data
verified every object (10, 266 and 403), every S3 call the app makes passed,
and this compose file migrated a copy end to end with `data/minio` left
byte-identical.

New: `objectstore:copy-from --endpoint=<url> [--apply]` copies whatever the
store lacks from another S3 store (dry run by default): the repair for an
upload that landed in MinIO during the switch, and a way in from any S3.
`prod-db-tunnel.sh` / `prod-tailscale-serve.sh` default to
`mantle_objectstore` (`MANTLE_MINIO_CONTAINER` still honoured); `reset.sh`
wipes `data/rustfs` too. The MinIO image (`infra/minio`) stays published for
rollback and for reading an old `data/minio`.

Deploy note: a changed default service set (`minio` out, `objectstore_init` +
`objectstore` in). Check free disk first (the copy needs the size of
`data/minio` plus a margin; the init refuses and the update fails cleanly
otherwise). After the roll: `docker logs mantle_objectstore_init`, then
`docker exec mantle_web pnpm -C packages/storage objectstore:verify`. Delete
`data/minio` only after a couple of weeks green.

## 0.232.246: a mini app appears when it's ready, behind the host's loader (branch feat/app-nav-folders)

An app used to announce `ready` in the same tick as `root.render()`, before
React had drawn anything, and the frame sat `display:none` until then: the
host said "Loading…", then showed a blank or half-empty app, then the app's
own spinners.

- **Ready means painted.** The kit posts `ready` after the first commit's
  frame (or a 100ms timer, since background tabs run no animation frames), and
  after the app's own mount effects, so its first bridge requests reach the
  host first.
- **Revealed when settled.** `AppSandbox` keeps its loader up until the app has
  mounted and its in-flight `host.db` / `host.tools` requests have been quiet
  for 150ms (the host brokers them, so it sees them), then cross-fades. Never
  longer than 8s after mount. The rules live in `share-ui/app-reveal.ts`.
- **Explicit hold.** `host.ui.holdReady()` / `host.ui.ready()` for work the
  host can't see; the Appsmith prompt and the app authoring guide say loading
  is the host's job.
- **A `loader` slot** on `AppSandbox` (the owner UI passes its thinking orb);
  the frame stays laid out under it, so an app measuring itself on mount gets
  real sizes. A crash during the first render now shows the host's failure
  state with its reason.
- **The app list knows what can be previewed.** `AppNavItem.hasBuild` is a
  green published or draft build (the frame-ticket test), and building,
  discarding a draft or publishing notify `app_nav_changed`.

## 0.232.246: apps get folders, pins, icons and colours in the sidebar, synced everywhere (branch feat/app-nav-folders)

The server half of the sidebar apps tree. A brain with a dozen or more mini
apps had no way to organise them: the sidebar showed one "Apps" row and the
list page sorted by date. Mantle now stores the organisation, so every client
(web, desktop, phone) renders the same menu.

- **Shared layout.** `appNav` is a brain-level preference (one record on the
  anchor row, like the theme): folders nested up to three levels, their order,
  and where each app sits. An app placed nowhere is "unsorted", which is where
  a new app lands. `GET /api/app-nav` returns the tree, the login's pins and
  open counts, and every app in slim form in one round-trip, already pruned of
  deleted apps. `PUT /api/app-nav { baseRev, entries }` saves it
  compare-and-set: when another client saved first the answer is 409 with the
  current layout, so two devices can't silently overwrite each other.
- **Personal pins and usage.** `PUT /api/app-nav/pins` keeps up to 12 pinned
  apps per login. `POST /api/apps/:id/opened` counts opens per login, feeding
  "Most used" and "Recent".
- **Favourites follow the person.** `PUT /api/profile/nav-favorites` moves the
  sidebar favourites off the browser's localStorage onto the login's profile;
  `GET /api/shell` returns them as `navFavorites`.
- **Icons and colours.** An app's icon may now be `lucide:<name>` as well as an
  emoji, and it takes a `color` tint key (`APP_TINTS`, never a raw colour, so
  each theme supplies its own shade). Both are projected on read, so an old
  icon value that isn't renderable reads as unset.
- **Live.** Layout, pin and app create/rename/recolour/delete writes notify
  `app_nav_changed`, broadcast on `/api/realtime` as type `app-nav`.

The pure tree logic (projection, strict write check, move/place/dissolve, and
the flattening the sidebar renders its guide lines from) lives in
`@mantle/content-core/app-nav`, so a move the client offers is one the server
accepts. Types and limits are in `@mantle/client-types/app-nav`.

## 0.232.245: the object store goes backend-neutral; `createbuckets` is gone (branch feat/objectstore-neutral)

Step 1 of moving off MinIO (to RustFS, planned): nothing outside the storage
package may depend on which S3 server answers. The bucket is now created by the
`migrate` one-shot with a plain S3 CreateBucket
(`pnpm -C packages/storage objectstore:ensure`), so the `createbuckets` service
and its dependency on MinIO's `mc` are gone; `scripts/up.sh` runs the same step
in dev. The S3 client sends flexible checksums only when an operation requires
them (the SDK default breaks on servers that do not implement them), and
`S3_FORCE_PATH_STYLE`, which compose always set, is now actually read.
`S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_FORCE_PATH_STYLE` can be
overridden from `.env`. New: `objectstore:verify` re-hashes every stored object
against its sha256 key, the check for any backend swap or data restore
(docs/backups.md). The dead presigned-URL helper went with its package.

Contract: `SystemHealth.storage.objectStoreUp` is added; `minioUp` stays as a
deprecated alias with the same value. Labels read "Object storage", the health
probe is `storage.objectstore`, and the sanity check's bucket fix is
`docker exec mantle_web pnpm -C packages/storage objectstore:ensure`.

Deploy note: removing `createbuckets` changes the default service set. The
updater's `up --remove-orphans` removes the old exited container; boxes
brought up by hand keep it harmlessly until their next `up --remove-orphans`.

## 0.232.244: our own MinIO image, so rolls and fresh installs pull again (branch fix/minio-own-image)

The v0.232.243 roll failed on every box at `compose pull`: the quay.io MinIO
images now answer 401, two weeks after MinIO deleted its Docker Hub repos. MinIO
has left open source (the repo is archived); the only image it still publishes,
`quay.io/minio/aistor/minio`, is the commercial AIStor build, and without a
licence it denies every S3 call. So we now build MinIO ourselves:
`infra/minio/Dockerfile` compiles the same pinned releases (minio
`RELEASE.2025-09-07T16-13-09Z`, mc `RELEASE.2025-08-13T08-35-41Z`) from
upstream's AGPL source, on the same ubi9-micro base, for amd64 and arm64, and
the new `minio-image` workflow publishes it as `titanwest/mantle-minio`. The
commit ids and `--version` output match the official binaries, and on a copy of
a real box's data every object came back with the same key, size and ETag.

The minio image already carries mc, so `createbuckets` and `scripts/up.sh` now
use it too: one image to host instead of two, and `MC_IMAGE_TAG` is gone
(`MINIO_IMAGE_TAG` still overrides the tag). Boxes recreate the minio container
once on their next update; the data is a bind mount and stays put. This is a
stopgap: replacing MinIO with a maintained S3-compatible store is planned.

## 0.232.187: MCP connectors sign in with pre-registered OAuth apps, so Power BI works (branch feat/mcp-entra-oauth)

Connecting Microsoft's Power BI MCP server failed silently: the connector sat
on "authorization pending" with no reason. Power BI signs in through Microsoft
Entra ID, which offers no dynamic client registration, and the connector flow
depended on it. An OAuth connector can now use a pre-registered app instead:
`microsoft` borrows the Settings → Microsoft app and signs in at its tenant (a
single-tenant app cannot use the `organizations` endpoint Power BI
advertises); `manual` takes an app registered by hand, sealed in the vault.
The Microsoft app always asks for `offline_access` (without it there is no
refresh token, and the connection died within the hour), shows the account
picker instead of the SDK's forced consent prompt (which blocks an
already-consented app on tenants without user consent), sends no RFC 8707
`resource` parameter, and posts the secret in the body. All through the SDK
1.30 provider hooks, no fork. Power BI ships as a catalogue entry with its
customer-side setup steps. Its redirect URI must be registered under the Web
platform, not "Mobile and desktop" as Microsoft's desktop-client guide says.

Bugs fixed on the way: a failed start, a refused consent or a failed code
exchange no longer leaves a silent `pending`; the reason lands on
`oauth.lastError`, with the cure appended for the common AADSTS codes. The
code exchange keeps the first token error instead of the one from the SDK's
own retry. A create whose authorization could not start now answers 201 with
`oauthError`, not a misleading "create failed".

API: `oauthClient` and `scope` on create and patch; the list also returns
`oauthRedirectUri` and `microsoftApp`. Contract (`@crossworks/client-types`):
optional `oauth.client` and `oauth.scope` on the MCP binding. 11 new tests
against an in-process Entra-shaped authorization server, plus 5 parser cases.
docs/mcp-connectors.md; help page extended.

## 0.232.184: MinIO images from quay.io: fresh installs pull again (branch feat/minio-quay)

On 2026-09-14 MinIO removed `minio/minio` and `minio/mc` from Docker Hub, so
every fresh install failed at `docker compose up` with "pull access denied for
minio/minio". Both images now come from `quay.io/minio/*`, which carries the
same pinned tags (`RELEASE.2025-09-07T16-13-09Z` / `RELEASE.2025-08-13T08-35-41Z`),
so no data or version changes. Prod compose, dev compose and `scripts/up.sh`
all moved. Existing boxes recreate the minio container once on their next
update (the image reference changed); the data is a bind mount and stays put.
`MINIO_IMAGE_TAG` / `MC_IMAGE_TAG` still override the tag only.

## 0.232.78: OpenAPI connectors: a service's spec as an http tool group (branch claude/zealous-leakey-73c34c)

The raw-API twin of MCP connectors, per docs/plans/openapi-connector.md.
Point the brain at an OpenAPI 3.x spec URL (JSON or YAML) and the selected
operations compile into ordinary `http` tools inside an `openapi-<slug>`
group; the dispatcher gained no new handler kind, and auth stays on the
group's own baseUrl/secretRef/authTemplate (never from the spec, whose text
is stripped of secret refs and whose per-operation server overrides are
ignored). Explicit sync with the mcp disable-on-vanish asymmetry; hand-edits
of mirrored tools are stamped and survive re-sync until overwriteEdited.
Selection by tag/operation with a hard 80-tool cap and a no-create preview
endpoint; `openapi-` namespace reserved across ensure/crud/generic routes;
KNOWN_OPENAPI_APIS catalog ships Open-Meteo (no key). One shared-engine
improvement: an http query pair whose optional `{param}` goes unfilled is
now dropped instead of shipping the literal brace string. API at
/api/openapi-connectors (+ preview, [slug], [slug]/sync);
docs/openapi-connectors.md; help page extended; 45 new tests including an
in-process spec-server end to end.

## 0.232.39: YouTube ingests from a VPS: the cookies-file escape hatch (branch claude/media-cookies)

Live testing surfaced the expected wall: YouTube blocks datacenter IPs
outright ("Sign in to confirm you're not a bot"), captions included, while
every other extractor works from the same box. The sidecar now honours an
optional operator-supplied `cookies.txt` mounted read-only at
`${MANTLE_DATA_DIR}/media/` — picked up per-request (no restart, delete to
disable), handed to yt-dlp as a per-run working copy so rotations never
write back and concurrent jobs can't clobber each other, and surfaced on
`/healthz` as `cookies: true/false`. This is the one deliberate exception to
the sidecar's holds-nothing posture, and the docs say so plainly: a scoped
browser-session export, some account-flag risk, goes stale on YouTube's
schedule. docs/video-ingest.md ("YouTube and the bot check") carries the
export recipe and the trade-offs.

## 0.232.37: client pair moves to jackdaw v0.6.5 (branch claude/client-pair-v0.6.5)

Interface-only roll: the paired jackdaw client moves to v0.6.5, which adds
the Media pill to the dashboard's system vitals (the yt-dlp/ffmpeg sidecar's
health + running versions, beside Tika/Chromium/Sandboxes) and ships the
files workspace's two-pane view series. No server-side changes beyond the
pair record.

## 0.232.36: video ingest hardened: the audit pass (branch claude/video-ingest-audit-fixes)

A three-way adversarial audit of the v0.232.32 video-ingestion release, with
every confirmed finding fixed. The two showstoppers were on the happy path:
the sidecar folded long video titles into multi-line HTTP headers that undici
rejects wholesale (every normal YouTube title made the client report
"unreachable" after paying for the full download), and the same encoding made
the duration header permanently unreadable. Headers now travel as single-line
percent-encoded tokens.

### Data safety

`syncFileFromDisk` replaced a node's `data` wholesale on any watcher-observed
byte change — silently erasing the per-file `indexing: 'metadata'` privacy
flag (a host-side re-save reverted a deliberately-excluded file to FULL
indexing) and video-ingest provenance. It now merges, clearing only the
extraction bookkeeping that genuinely must recompute. The file-node ingest
path could overwrite its own source (an `.mp3` input re-encoded onto itself)
or a same-named sibling; clips now save as `<base>-audio.mp3`, never
overwriting. The watcher gained a 512 MB sync cap so a dropped `.mkv` can no
longer OOM-kill the worker, and transcript pages point their `sourceFileId`
at the video only — deleting a disposable clip can no longer reap the
transcript. Migration 0151 backfills the pre-existing filename-only false
successes for media (LLM-free by construction).

### Sidecar protocol and process hygiene

Error responses close the connection (an unread request body no longer
poisons the keep-alive stream — a 429 on a 1 GB upload now arrives as a 429,
not "unreachable"); negative Content-Length can no longer wedge the
concurrency slots; subprocesses run in their own process group and the whole
group dies on timeout (compose runs the container with `init: true` so tini
reaps the orphans — SIGCHLD auto-reap was rejected because it silently zeroes
every child's exit code); the sidecar re-checks resolved addresses against
private/link-local ranges before yt-dlp fetches anything; live streams are
refused up front; the merged video is re-measured against the cap
(`--max-filesize` is per-stream); probe/captions gained their own concurrency
bound; malformed numerics are 400s, not 500s; and a missing token now serves
a degraded `/healthz` naming the problem instead of crash-looping.

### Pipeline honesty

Manual (human-authored) captions are exempt from the auto-caption garbage
heuristics — a tersely-captioned four-hour talk is no longer thrown away on a
vocabulary ratio. Google STT measures its 20 MB cap on the base64 wire size
and fails loudly on MAX_TOKENS truncation instead of shipping six minutes of
a forty-minute transcript as if complete, with `maxOutputTokens` raised to
the model max. `keep_video` now restamps the audio clip's provenance to the
video and is ignored (with a note) off the web surface, where a 25-minute
download reads as a hang. `.html`/`.htm` route to Tika instead of regressing
to unindexed. `file_node_id` gets a real precondition (teaching error, not a
Postgres 22P02) and size/mime gates run BEFORE the bytes are read. The ops
surface caught up too: `.env.prod.example` documents the profile with its
update-first ordering (enabling on a pre-media tag broke `docker compose
pull` for the whole stack), `docs/deploy.md` and the disposition catalogues
cover the new skips, and forks can build the `mantle-media` image via
`scripts/docker-build-push.sh`.

## 0.232.32: video ingestion: paste a link, get a searchable transcript (branch claude/mantle-video-extraction-650157)

The brain can now ingest a video. `video_ingest` takes a link (or a video
file already in Files), pulls the captions when the video has them — free and
already timestamped — and only when it doesn't extracts a speech-grade audio
clip and transcribes it through the owner's STT worker. The result is a real
transcript page: summarised, embedded, chunked with `## [m:ss]` timestamp
headings folded into each retrieval chunk, so "what did he say at 4:12" is
answerable months later without the video. The audio clip is kept as a
durable artifact beside its source, saved before transcription so a failed
STT run is an explicit partial success with a retry path, never a silent
nothing. Full design and caps: [docs/video-ingest.md](docs/video-ingest.md).

### yt-dlp and ffmpeg live in their own container

The fetch/transcode engine is a new sidecar (`infra/media-sidecar`, compose
profile `media`, image `mantle-media`) with no database, secrets, or
file-store access — because it runs the one dependency this repo refuses to
pin. yt-dlp breaks whenever a site changes its player and upstream fixes land
within days, so the sidecar refreshes it from PyPI at boot and daily, and the
running version is surfaced on `/healthz`, the health panel, and the
integrity readiness panel. URLs are SSRF-checked in the app before the
sidecar ever sees them, and the tool is owner-only: the `video-ingest` group
is never granted to the team responder.

### The file layer stops lying about media

When a media file's name cleared a 20-character length check, the extractor
indexed the FILENAME as the document body and recorded success — the exact
"filename-only false success" the `.mpp` handling exists to prevent, open for
every other parserless format. A generalised hollow-body guard
(`isHollowFilenameBody`, pure and tested) now closes it for all of them, and
media specifically records an honest `unsupported_media` skip pointing at
link ingestion. Building on v0.232.29's media MIME families and v0.232.30's
metadata-only indexing: the clips this tool saves are stamped
`indexing: 'metadata'` so they carry the deterministic name/type/tags spine,
and the disk-sync watcher now stores dropped media instead of silently
ignoring it — never transcribing on its own; transcription is only ever the
explicit tool.



SheetJS (`xlsx`) read every spreadsheet that entered the brain. It has not
published to npm since 0.18.5, and that release carries a prototype-pollution
and a ReDoS advisory — both reachable, because the code parses bytes a user
uploaded. A vendor CDN tarball patched the advisories but left a dependency
with no registry behind it, which is not a place to leave a parser.

`exceljs` replaces it. It was already in the tree writing `.xlsx` on the export
side, so this consolidates read and write onto one engine rather than adding
anything.

### The hang guard turned out to be unnecessary

The caps in `parseXlsx` existed because SheetJS's `sheet_to_csv` walked a
sheet's DECLARED dimension. Workbooks routinely declare a used range out to row
1,048,576 / column XFD around a handful of real cells, so an unbounded parse
iterated millions of phantom cells — two prod uploads hung ingest past the
10-minute watchdog that way.

`exceljs` builds rows from the cells that actually exist and ignores
`<dimension>` entirely. A workbook declaring `A1:XFD1048576` around 4 real rows
now loads in 6 ms. The row and column caps survive, but they are OUTPUT bounds
now — what reaches the chunker and the embedder — not a defence against a
stall, and a phantom range is no longer reported as truncation, because nothing
was dropped.

What did need replacing is the memory bound. `sheetRows` capped the read;
`exceljs`'s `load()` has no equivalent, so `sheet-read.ts` pre-flights instead:
sum the uncompressed worksheet XML straight from the zip directory, and refuse
past 32 MB (measured blow-up is ~25x to RSS — 100k rows x 10 cols is 40.8 MB of
XML and ~1 GB resident). Text extraction then falls through to Tika, which
parses out-of-process in its own capped heap; a grid import raises instead,
because a partial import that looks successful is worse than an error.

### `.xls` and `.xlsb` convert on ingest

`exceljs` reads OOXML only, and legacy auto-detection was the one thing SheetJS
did that it does not. Rather than keep a second engine alive for two formats,
those bytes are now converted to real `.xlsx` at the door and take the ordinary
path from there — one reader, one set of caps, one output shape.

The converter is Apache Tika, already a service in the compose stack: it is
Apache POI underneath, so it reads BIFF properly, and using it costs no new
container and no LibreOffice in the image. Honest about what it costs: Tika's
XHTML is a rendering, so **boolean cells are lost** (they render empty, though
column alignment survives) and **dates arrive as display text**. Numbers come
through and re-infer cleanly. In practice this is theoretical — across the dev,
prod and a client brain there is not a single `.xls` or `.xlsb` — and
`legacy-sheet.ts` records exactly what degrades if one ever lands.

### Smaller consequences

- `parseSheetToGrid` and `parseTextToGrid` are **async** now (`load()` is
  promise-based, and legacy conversion is a network call). Ingest paths should
  call the new `parseSpreadsheetToGrid(bytes, ext)`, which handles the legacy
  conversion, so the auto-table pass, the Tables import route and
  `table_from_file` cannot drift apart.
- Pasted and uploaded CSV/TSV parse with `fast-csv` rather than SheetJS —
  quoted delimiters, doubled-quote escapes and newlines inside quoted fields
  all keep working, and a tab inside a quoted CSV field no longer flips the
  whole parse to TSV.
- Dates in extracted text render ISO rather than whatever display format the
  sheet happened to carry, so a date in a query can actually match one in a
  spreadsheet.
- The `parse_document` trace's `parser` field gains `exceljs` and
  `legacy-sheet` in place of `sheetjs`.

## 0.232.7: sheet_build reaches MCP clients too (branch feat/sheet-build-mcp)

`sheet_build` shipped to the in-app agents but was never registered on the MCP
surface, so a Claude Desktop or Claude Code session could not call it. That is
the surface most likely to want it: the client is often the one holding the
numbers, working through a costing, and wanting a file back at the end.

One line next to `export_node`, which is on that surface for exactly the same
reason. Both transports (stdio and the HTTP route) build from the same builder,
so both get it.

## 0.232.6: an agent can build a spreadsheet, not just a table (branch feat/sheet-build)

An agent could already produce a styled `.xlsx` in two steps: `table_create`
then `export_node`. That is right when the thing being made is DATA. It is
wrong when the thing being made is a DOCUMENT, because it creates a stored
table nobody wanted in order to get a file.

`sheet_build` writes straight to bytes and stores nothing. The line, for anyone
extending either side: **a table is data you query, a sheet is a document you
send.**

### The spec is deliberately small

The temptation was to expose exceljs. An agent given fonts, ARGB fills and a
border API invents a different look every time, and a brain that emits ten
differently-styled spreadsheets is worse than one that emits ten identical
plain ones. So the spec carries CONTENT and INTENT (what the column means, what
to total) and the renderer owns every visual decision.

Styling is three presets and nothing else: `report` (default, for anything
going to another person), `plain` (no fills, for a sheet the recipient will
re-style or pivot), `compact` (dense reference data, where banding is noise).

A sheet takes an optional `title`, written as a bold merged row above the grid
with a spacer beneath it. The spacer is load-bearing: it stops Excel reading
the title as part of the table the first time someone hits filter.

### Rows are objects, not arrays

Keyed by column, always. A positional array is rejected outright rather than
accepted leniently, because a value omitted from an array shifts every column
after it, and the result is a spreadsheet that is wrong in a way that looks
completely fine. Keying turns that same mistake into a named error before a
file is ever written.

The whole spec is validated before any bytes are produced, and every message
names the sheet and the key at fault: an agent that reads "unknown column key
'amout' on sheet 'Revenue' (expected: client, amount)" fixes it next call.

Capped at 10 sheets, 5,000 rows a sheet, 20,000 total. Past that you are not
building a document, you are moving a database through a tool call, and the
error says to import it as a table instead.

### One house style, shared

The palette, the sizing rules and the type-driven formatting moved to
`packages/content/src/xlsx-style.ts`, and both spreadsheet writers import them.
Two copies would have drifted, and the first person to notice would have been a
client holding two files from the same brain that did not look related.

Ships as a `spreadsheets` tool group granted to the persona and to Ledger, plus
a `spreadsheet_authoring` skill on Ledger covering the sheet-versus-table call.

## 0.232.5: a table exports as the workbook it actually is (branch feat/xlsx-export-polish)

Downloading a table gave you one worksheet. Since Tables v2.1 a table has been
a WORKBOOK — every sheet of an imported spreadsheet becomes a tab of the same
table — so a six-tab table downloaded as its first tab, silently. Nothing said
so. `renderXlsxWorkbook` now writes one worksheet per tab, in tab order.

Markdown and CSV still export the open tab alone, on purpose: they are
single-grid formats, and flattening six tabs into one CSV would interleave
unrelated grids under one header.

Tabs whose names collide after sanitising get a numeric suffix rather than
throwing. Excel refuses duplicate sheet names, and `Q1/Q2` and `Q1?Q2` sanitise
to the same thing, so the alternative was a download that never happened.

### The file should be readable the moment it opens

That is the only reason to prefer .xlsx over CSV, so the export now applies a
house style instead of shipping bare data:

- A frozen, filterable header on a slate band, white and bold.
- Columns sized from their contents, floor 10 and ceiling 60 characters.
- Alternate rows banded with a hairline tint.
- Numbers right, checkboxes centred, text left.
- Dates as real date cells formatted `yyyy-mm-dd`, so a shared export cannot be
  read as 3 April in one office and 4 March in another.
- `url` columns become real hyperlinks, when the value is actually navigable.
- The totals row banded and ruled off from the data.

Two constraints shaped the palette. It has to survive greyscale printing, and
it cannot fight the reader's own dark mode, since a fill we write is fixed
forever. So nothing carries meaning by colour, and the great majority of cells
are left unfilled.

### Three bugs the polish surfaced

- **A money column showed `#######`.** Widths were measured from the STORED
  value, so `12500` was sized as 5 characters when it displays as
  `USD 12,500.00`, 13. Totals are wider still than any row they sum, so they
  are computed before the widths are set now.
- **A leading total was replaced by the word "Totals".** The label was written
  on a falsy check, so a first column whose sum came to 0 lost it. The label
  now goes to the first column that has no aggregate of its own.
- **A row COUNT inherited its column's money format**, so `count` on a currency
  column rendered the count as an amount.

## 0.232.0: a member can see the drawing the reply is talking about (branch feat/team-forum-drawings)

`![alt](draw:<node-id>)` in a reply now resolves, on both member surfaces.
Pictures have worked since v0.4.1; drawings were the marker in the Forum plan's
§5 table listed simply as "broken".

Two routes, `forum/drawing/[nodeId]` and `messages/drawing/[nodeId]`, siblings
of the media pair rather than a widening of it: `serveTeamMedia` streams file
bytes and refuses any mime that is not an image, which a draw node is not. Same
door, same gate, different thing behind it.

**Authorization is the media routes', unchanged.** The question is asked of the
POSTS — "is this node attached to something this member can already read?" —
never of the drawings tree, because that second question answers "any drawing
the responder ever touched". Absent, forbidden and malformed all answer 404.

The hardened SVG response lives in `lib/team-media.ts` as `serveTeamDrawing`
rather than in the two routes, so the Forum's copy and Team Chat's cannot drift
apart on a security header. An SVG is markup: served as an image it is a
separate script-disabled document, but this URL can also be opened directly, and
the `sandbox` CSP is what makes that case inert. Copied from
`/s/[token]/draw/route.ts` — if one changes, change both.

Both surfaces get it, deliberately. A marker that rendered in the Forum and
broke in Team Chat would be worse than not having one: the reply text does not
know which surface it will be read on.

## 0.232.0: a shared table gets the owner's totals, and they are RIGHT (branch feat/team-tables-grid)

`/team` tables were a centred `max-w-6xl` reader: a plain table, a "Load more"
button every 200 rows, and no totals at all. The owner grid has had per-column
aggregates and a sticky footer for a long time; none of it reached the people
the table was shared with.

### The totals had to come from the server, and that is the whole design

A file-backed workbook pages 200 rows at a time. A sum computed from the rows a
reader happens to be holding is not a smaller number — it is a **wrong** one,
and it looks exactly as authoritative as a right one. So:

- The share view now carries each tab's `aggregates` (the owner's settings) AND
  `aggregateValues`, computed server-side by `aggregateWindow` in SQL across
  every row. `describeWorkbook` grew an `aggregates` field to read the
  workbook's `_aggregates` table.
- **`GET /s/[token]/aggregate?tab=&col=&kind=`** answers a total the READER
  picks. View-local, never persisted — nothing on this surface writes. `kind` is
  validated against `AGGREGATE_KINDS` rather than cast, because it reaches a SQL
  expression builder. Authorization and the uniform 404 are the rows route's,
  verbatim.
- Legacy JSONB tables are the one exception, and only because they genuinely
  arrive whole: there the reader computes locally and no round trip happens.

A column that cannot carry a total — a formula target, a sum over text —
returns `null`, and the footer draws a blank. A `0` would be a statement about
the data that nobody made.

### The grid

Embedded (`chrome="embedded"`, v0.231.0) the presenter now owns its height: the
header and tab strip are fixed and the table scrolls in a bounded box, so the
**sticky header and sticky footer have something to stick to**. Column headers
carry the owner grid's own type icons. The "Load more" button is gone —
an IntersectionObserver sentinel fetches the next page as the reader
approaches it, and the header reads "N of M rows" so nobody wonders whether
there is more.

The footer row renders even when nothing is set, because the row IS the
affordance: a member who wants a total needs somewhere to ask for one.

The standalone `/s` page keeps its centred, growing, non-sticky layout.

## 0.232.0: an event listing that says when, not when it was edited (branch feat/team-list-event-time)

`TeamVisibleShare` gains an optional `startsAt`, read from `nodes.data.starts_at`
and null for every non-event type.

Every other field on that DTO describes the SHARE. This one describes the thing
shared, and it is carried because for an event the two are not interchangeable.
The `/team` section cards show `updatedAt` — right for a note or a table, and
useless for an event. A member scanning what is coming up needs when it
*happens*; an event edited this morning has no business sorting above one that
starts tomorrow.

The row query already selected `nodes.data`; the mapper simply read `icon` and
`summary` out of it and dropped the rest, so no query changed. Optional on the
type, so a client pinned to an older server still parses the payload.

## 0.231.0: the share presenters learn which shell they are in (branch feat/team-presenter-chrome)

Every presenter in `@mantle/share-ui` was written for one surface: the
anonymous public `/s` page, where the presenter *is* the page. `/team` then
reused them inside a master-detail pane, and two of those choices became wrong
at once.

The pane draws the item's title in its own header, so the presenter's hero
title was the second of three on screen. And the centred `max-w` cap meant
dragging the pane divider only grew the empty margins while the content stayed
a fixed narrow column — members read that as "the drag is broken". The handle
was fine; the content was ignoring it. A non-previewable file was the worst of
it: a `max-w-md` card, phone-width, marooned in the middle of a 2000px pane.

### `chrome`, an optional prop on six presenters

`chrome?: 'share' | 'embedded'` — Note, Event, Task, File, Table and Draw.

`'share'` is the default and is byte-for-byte what shipped before, deliberately:
the public page must not change because an embedder forgot a prop. `'embedded'`
means the surrounding shell already owns the title and the padding, so the
presenter drops its hero title, tightens the vertical rhythm, and stops
centring.

⚠ `'embedded'` is **not** a synonym for full-bleed. It means *the shell owns
the chrome*; what to do with the width is still the content's call. A table, a
media viewer and a file row all get better as they get wider, so they span the
pane. A note does not — a 2000px line is unreadable in anyone's pane — so prose
keeps its measure and simply stops being centred under a title it no longer
draws. The bug was a floating box, not a reading measure.

Event and Task also drop their card frame when embedded. On an empty page that
border is what tells a reader where the item begins; inside a pane that already
has a header rule and a border of its own, it is the box.

### The folder listing can carry a Modified column

`ShareFolderListing.files[]` gains an optional `updatedAt`, populated by
`GET /s/[token]/view`. `FileRow` already carried it — it was simply not being
passed on, so no consumer could show when a file last changed. Optional, so a
client pinned to an older server still parses the payload.

## 0.230.67: Tasks grows up: a board, a lifecycle, and somewhere to put finished work (branch claude/handover-tasks-kanban-04d026)

`/tasks` was a checklist. It is now a project surface: a Kanban board, four
states instead of two, a checklist inside each task, and comments from logins,
team members and agents.

### The board shows three columns, not four

Blocked is a flag on work already under way, not a further stage, and a fourth
column cost more width than it earned. Blocked tasks render under **In
progress** with a badge, and you set the flag from the task form.

Reordering a blocked card inside that column no longer clears the flag. The
column a card lands in and the status written are two different things now,
which they were not before — tidying a column used to unblock tasks as a side
effect.

### Archive: where a thousand finished tasks go

A Done column grows forever. Archiving files a task away without deleting it:
`data.archived_at` on the node, excluded from **every** list, count, board and
tool unless asked for (`?archived=only|all`, `task_list`'s `archived`). The
exclusion lives in `taskConds`, the one place every query already goes through,
so no caller can forget it.

Archive is orthogonal to status: an archived task keeps the status it had. And
archiving is metadata — deliberately absent from `updateTask`'s
`contentChanged` check, so filing a thousand tasks away costs zero embeddings
and zero LLM calls.

### Smaller things you will notice

- The checkbox no longer flattens four states into two. Ticking a Blocked task
  and unticking it restores **Blocked**, not To do.
- The comment composer sits above the thread, newest comment first.
- The task form, the detail view, the task list, the nav rail and the activity
  column are all resizable, and each remembers its width.

## 0.230.58: Links that survive the split (branch feat/companion-split-fix)

**A stored link is permanent, so it has to be right on the day it is written.**
`nodeUrl()` mints `${MANTLE_PUBLIC_URL}/n/<id>` and hands it to the assistant on
every tool result; the assistant writes those links into chat replies, pages,
forum answers and outbound email, and nothing ever re-resolves them. But
`MANTLE_PUBLIC_URL` has to be the **server** origin — `/s/<token>` share links
and the Microsoft OAuth callback are served there — while `/n/[id]` itself moved
to `client/web` in the v0.200.0 split. On a deployment that gives the owner app
its own vhost, every one of those links was a 404, and each one was written into
the brain to stay.

`/n/*` now forwards to `MANTLE_CLIENT_ORIGIN`, joining the `/login`, `/hub` and
`/team` stubs. Keeping the minted link canonical and redirecting at the edge is
what makes one stored URL correct under either topology; rewriting the minter to
point at the client origin would have broken it the other way. With no client
origin configured it explains itself instead of looping, same as its siblings.

Single-host installs — where one hostname fronts both stacks — never saw this,
which is exactly why it stayed hidden.

Also: `GET /api/assistant/thread` takes `?withMessages=0`, returning the agent
picker list and the resolved active agent without the 100-message thread. The
mobile companion needs both at launch — it holds no agent cookie, so the
server's resolution *is* its default, and that resolution is what now respects
`agents.assigned_user_id` — but it pages its own history from the local cache,
so the thread was fetched and dropped on every cold start. Opt-out, so every
existing caller is untouched.

## 0.230.14: Four fonts, one library, every face variable (branch claude/variable-font-refactor)

**A typeface library is not a list of decorations.** The old one had grown into
two registries with different rules: twenty-two display faces for the wordmark,
twelve for the interface, most of them chosen to be striking for two words of
header. Anything you would actually set a document in was accidental.

There is now one library of sixteen families, and every one is a variable font
with at least two axes. One file carries every weight, and where a family has a
slant axis, its italic too.

### Four things you can set

Settings and Appearance now offers a face and a size for each of the interface,
the wordmark, the peer name, and a new one: **Pages and Notes**. That last is
the only typography choice in the product that leaves the browser, because it
typesets the PDF export as well as the editor and the share page.

Each row opens the same chooser rather than spilling the whole library down the
page: filtered by kind, previewing every face in your own text. The peer name
and Pages/Notes default to "same as interface", so a brain that picks one font
still looks deliberate. Sizes gained an Extra small, and the three new ones
scale only what they name; Interface size still scales the whole shell.

### The ranges are read out of the files, not typed

`scripts/fonts-import.mjs` parses each font's own `fvar` table for its real axis
ranges, converts to woff2, installs into both apps with the licence, and prints
the registry row. It refuses a face with fewer than two axes.

This is not tidiness. A variable font declared without its weight range makes
the browser treat the file as a single regular and fake the bold, which shows up
as smeared headings across every screen. Hand-typing sixteen sets of ranges is
sixteen chances to introduce that quietly.

Faces stay lazily fetched: a file downloads only when something actually paints
in it, so the library costs nothing until you choose from it.

### Two things that were already broken

The interface font never reached share links or `/print` at all. Only the two
header faces were stamped into those documents, so a share always rendered in
Inter no matter what the brain had chosen. Both surfaces now carry every font
the app does, which is what makes the Pages/Notes choice reach a PDF.

Separately, the Appearance screen showed Inter as the selected interface font
however you had it set. The face was applied correctly; the attribute the picker
reads its state back from was never rendered.

### What went away

Bukhari Script and the twenty-two decorative faces are gone. An existing brain
that had chosen one falls back to the new default rather than stranding, which
is what the registry contract has always promised. The default wordmark is now
Bricolage Grotesque, and Mantle's own mark in the footer follows it.

Only one monospace family survives the two-axis floor (Inconsolata). More can be
added at any time: that is now one command and one pasted row.

## 0.224.0: The models you pinned, and whether they still exist (branch feat/model-drift)

**A pinned model is a decision, not a subscription.** It was right the day it
was chosen and nothing ages it. Nothing in the product ever checked whether the
ids `agents.model` and `ai_workers.model` actually send are still real — the
first sign of a delisted model is a failed conversation.

`pinned-model-drift` is a new read-only maintenance report, on the nightly
schedule alongside `deps-drift`. It reads every enabled agent and worker, asks
each provider what it currently lists, and reports pins that no longer exist
plus newer versions of the same family. It never rewrites a model: which one
you run is a cost and behaviour decision, and that stays yours.

It does not replace `models-drift`, and the two are easy to confuse.
`models-drift` is catalogue-level — does our onboarding dropdown still offer
what providers serve — and it deliberately skips OpenRouter, whose list is
built from the provider and cannot drift. That is true of a catalogue and false
of a pin, so this report covers exactly what that one skips.

**Most of the work here is in not crying wolf.** The naive version was written
first and pointed at the real fleet, where it confidently reported three
retired models across five healthy boxes. All three were the checker being
wrong:

- OpenRouter's `/models` enumerates **chat models only** — no TTS or STT id
  appears in it at all — so every voice worker read as dead. A pin is now
  compared only against catalogue entries of its own modality, and the modality
  comes from the row, never from the catalogue.
- `~x-ai/grok-latest` is a **real, current** id; the tilde is OpenRouter's
  auto-alias marker. Ids are matched exactly, never normalised or tidied. An
  alias is also never told that something newer exists — tracking the family is
  the point of pinning one.
- A provider with no list API, or one whose key is missing, tells us nothing.

So everything unjudgeable is reported as **not checked, with the reason**,
never as missing, and every cannot-see case is decided before any conclusion
about the id. A report that flags healthy pins gets muted within a week, and
then the genuine delisting goes unread too.

One judgement is stated wherever the output is read rather than buried in the
source: version segments compare as integers, so `4.20` is newer than `4.5`,
matching how these vendors number releases rather than how decimals sort.

## 0.223.3: An assistant that answers to its own name (branch feat/agent-name-token)

**A copied assistant introduced itself as the one it was copied from.** Give a
login its own assistant called Tommy and his prompt still opened *"You are Mira
— a specialist assistant to a Risk-Based Inspection team"*, because cloning
copies the prompt verbatim and the name lived in the prose. Caught on a live
box the day per-login assistants shipped.

The name and the prompt were always two separate columns with nothing keeping
them in step, so the same bug was already there without any cloning: renaming an
agent in Settings → Agents writes `name` and never touches `system_prompt`, so
it kept introducing itself by the old one.

An assistant's name is now a token in its prompt — `{{name}}` — resolved once
per turn from the agent actually running. Rename it and the prompt follows;
copy it and the copy is itself.

Three things had to agree for that to be true:

- **Resolution happens at the composition seam**, the one function every
  surface routes through — real turns, delegated specialists, heartbeats, runner
  workers, the Studio sandbox, and Studio's composed-prompt preview. Substituting
  any deeper would have let the model see a name the preview didn't, which is the
  hidden prompt that seam exists to prevent. The name is a required argument, so
  a future call site cannot quietly omit it — which immediately earned itself:
  it caught a sixth call site (delegated specialists) that a search for the
  function had missed.
- **The persona bank stops baking names in.** New assistants are name-agnostic
  from the start. The token is declared in two packages because the bank is a
  browser-safe leaf that the resolver depends on, so importing back would cycle;
  a tripwire test fails if the two literals ever drift, and caught a missing
  export the first time it ran.
- **Cloning rewrites the source's name to the token, not to the new name.**
  Baking "Tommy" in would recreate the bug the moment anyone renamed Tommy.
  Whole-word and case-sensitive, so an assistant called Max doesn't turn
  "maximum" into a template.

A prompt that never mentions its own name is unchanged, byte for byte — the
cached prefix every turn depends on is untouched until a brain opts in. The
existing `{{secret:service/label}}` refs are a different mechanism resolved in
the HTTP tool dispatcher, and are never matched: their syntax appears verbatim
in the toolsmith skill's own instructions, and a greedy matcher would have eaten
the example it teaches from.

## 0.220.0: Your own assistant, not everyone else's thread (branch claude/per-user-agent-duplication-60eb10)

**Two people signed into the same brain were talking to one assistant, in one
conversation.** Extra logins have always been co-admins on the anchor account's
data rather than tenants, and chat was never split off that: every login
resolved to the same default agent, and the conversation store is keyed
`(owner_id, agent_id)`. So a second person's turns appeared mid-thread, and
worse, each turn's history block handed the model the other person's words as
though the user had said them.

A login can now have its own assistant. In Settings → Users, name one when you
add a login (or later, from that login's panel) and pick which agent to copy;
the copy becomes that login's default chat target. Because the stream was
already keyed per agent — as are the live-turn NOTIFY payload, unread cursors,
digests and the inbox — one pointer, `agents.assigned_user_id`, splits all of
them at once. There is no new scoping model.

The copy is the same assistant with its own history: model, route, prompt,
skills, tool groups and delegation all come across, so it can reach the shared
specialists from its first turn. Three things deliberately don't:

- **Persona notes.** What an assistant learned about the person it was talking
  to is about *that* person. A copy starts with none.
- **Telegram.** A bot binding is a row against the old agent id, so a copy has
  no transport and no credentials — by construction, not by filtering.
- **Rank.** A copy sits one priority below its source. Headless callers (event
  reminders, heartbeats) break priority ties on slug, so an equal-ranked copy
  named `aaron` could quietly have become the brain's background default.

**This is separation, not privacy, and the screen says so.** The brain is still
one trust boundary: every login can open every assistant from the picker, and
`recall_window` replays any thread. What changes is that your chat is your chat.

The sticky agent cookie is per-browser, which would have made this land nowhere
for the exact people it's for — someone already chatting to the shared assistant
keeps landing there. The thread payload now carries when the assignment was
made, and the client switches over once against a local watermark; a deliberate
pick from the picker afterwards is left alone.

Releasing an assistant only drops the binding. The agent and its whole archive
stay, as an ordinary shared agent — deleting one remains a deliberate act on
Settings → Agents, same reasoning as the earlier fix that stopped agent deletion
destroying chat history.

## 0.219.0: A picture where the sentence needs it (branch claude/vibrant-elion-4dda88)

**A chat reply could not put a picture mid-answer.** Every image a turn produced
was collected and rendered as a strip below the whole reply, in the order the
tool was called. For the case this feature exists for, an illustrated walkthrough
of a product manual, that is the wrong shape: the reader wants each step's
screenshot under that step, not a clump at the bottom to map back by counting.
v0.218.10 corrected the prompt to describe that limit honestly. This removes the
limit instead.

The renderer already had everything. Chat replies render through the same TipTap
schema Pages uses, image node included, and that node resolves a stored file from
its id. The missing link was one converter: `markdownToDoc` (Pages, server-side)
turned `![alt](media:<file-id>)` into a real image, while the chat converter let
it fall through to a broken `<img src="media:...">`. So the same syntax now works
in a reply, and the assistant writes each screenshot where it belongs.

Two converters drifting is how the bug happened, so the reference schemes
(`media:`, `page:`, `mention:`) moved to one dependency-free module both import,
with a test that runs the same markdown through both and fails if they disagree
about which picture goes where. The standalone form deliberately does not go
through `marked`: the `<p>` wrapper it adds makes ProseMirror close an empty
paragraph before the image, putting a blank line above every picture.

Three edges, decided rather than left to chance:

- **Shown twice.** A reply that writes the image inline *and* calls `show_image`
  for the same file used to show it in both places. The reply's own placement
  wins; the strip copy is dropped at finalize. Mechanical, not prompt-only,
  because a confused model doing both is exactly the case a prompt misses.
- **Mid-stream.** A half-typed `![alt](media:` is not a complete markdown image,
  so it stays literal text until the closing paren lands: no crash, no
  broken-image flash. The live stream buffer resolves finished markers through
  the same route the durable reply uses.
- **Telegram.** That surface sends plain text, where a marker would arrive as
  literal `![...](media:...)`. Inline markers are stripped on the way out and
  counted on the trace. `show_image` remains the only path that delivers a photo
  there, and `visual_answers` now says so.

No new surface area: the `<img>` hits the same owner-gated bytes route Pages and
the attachment strip already use. It answers unauthenticated with 401 and scopes
every read by owner id, so an invented or someone else's file id is a broken
image, never a leak.

## 0.217.5: One implementation per tool, one verifier per credential (branch feat/arch-cleanup)

**24 MCP tools had two implementations, and the spare had gone stale.** Notes,
tasks, events, journal entries, peers and the email reads were each written
once as an in-app builtin and again by hand for the MCP server. Only the
in-app one gets exercised in development, so the MCP twin quietly fell behind:
`note_create` recorded no ingest provenance, so a note made from Claude Desktop
appeared in its own biography from nowhere; reads returned no permalink and,
worse, answered a missing row with a bare `not found` and no `isError`, which a
client reads as success; `task_list` returned a bare array where every other
surface returns `{tasks, count}`.

They are now bridged from the in-app definitions, so both surfaces run one
implementation. **This changes MCP response shapes** — if you parse these tools'
output in a connector, re-check it:

- `task_list` returns `{tasks, count}` (was a bare array).
- `task_get`, `note_get`, `event_get`, `journal_get` include a `url` permalink,
  and answer a missing id with a structured error flagged `isError` plus the
  tool that finds the right id.
- `note_create` / `note_update` accept a title over 200 characters by
  truncating it, where the hand-written tool rejected the call.

The MCP surface itself is unchanged: every slug that was exposed still is, and
bridging deliberately did NOT pull in the other members of those groups —
`email_send` and `email_page` in particular stay in-app only, since exposing
outbound email over MCP is a decision, not a refactor. `page_get`/`page_list`
and the table reads keep their hand-written ProseMirror/row shapes on purpose.
A test pins the remaining overlap exactly, so it can only shrink.

**The bridge also validated less than the in-app dispatcher.** Declared
preconditions were never checked, so an id naming a missing — or wrong-type —
node reached the handler and came back as an unhelpful `not found` instead of
the teaching error every other surface gives. And the JSON-Schema→zod
conversion silently dropped every size bound, so MCP was the only surface that
would accept `contact_list limit=500` against a declared maximum of 200. Both
are fixed for all bridged groups, including the seven bridged before this
change.

**The chat worker's "Test" button did not test what production runs.** It read
`api_key_id` directly, took the adapter and called `.chat()` — reproducing
neither of the two things chat routing actually does. So it lied in both
directions: a keyless `local` worker failed its test with *no api_key
configured* while working perfectly in production, and a worker whose primary
was down but whose backup was healthy also failed, though every real caller
would have been served. It now goes through `resolveChatRoutes` +
`chatWithFailover` — the production path — and reports which route answered, so
a green tick that came from the backup says so. The other modalities' test
buttons are left exactly as they were: they resolve keys the same way
`builtins-workers.ts` does, so they were already faithful.

Also hardened the embedding failover classifier, which decided 4xx-vs-5xx by
searching the message for any three-digit number — so an error mentioning a
dimension count or a port could be read as a client error and strand the caller
on a dead primary. It now prefers a status the error actually carries, and the
message fallback is anchored to the reported-status position. It stays separate
from chat's `classifyChatError` on purpose, with the reason written down: that
classifier reads a structured status the embedding adapters do not throw, and
its retryable set would drop 501 and proxy 52x — exactly what a self-hosted
primary behind a tunnel returns when it is down.

**Separately, `lib/auth` had five copies of its signature check.** There was a
shared `sign()` but no shared verifier: the split-on-dot, HMAC and
constant-time-compare preamble was pasted five times, differing only in which
kind byte followed — duplicated constant-time comparison in the module 265
others depend on. They now share one verifier, and the file splits along the
boundary its own comments already drew: `auth/tokens` (pure crypto),
`auth/session` (cookies, headers, `auth.users`) and `auth/request` (reading a
credential off a Request), behind an unchanged `@/lib/auth` façade. Four bearer
parsers that had genuinely diverged on whitespace become one, with the
null-vs-empty rule the gates depend on stated and tested; the rate-limit denial
shared by the four credential-exchange endpoints and the SSO origin check move
to `auth/preflight`. No behaviour changes — the kind-isolation matrix is now
pinned by a test that mints every credential and offers it to every verifier.

**The ten workers each hand-wrote the same shell**, and the copies had drifted
where it shows least: one shut down synchronously, two exited from a
`setTimeout` racing their own cleanup, and none bounded how long shutdown may
take — so a wedged `boss.stop()` left a container that looked alive and did
nothing until Docker's grace period ran out. `runQueueWorker` / `runWorker` now
own that shell; 1053 lines of worker become 715. Three things the fleet did not
have: signal handlers installed BEFORE setup (the three workers that block in
`waitForOwner` on a fresh brain previously met Node's default handler), a
shutdown deadline that exits non-zero and says so, and an explicit keep-alive —
"stays up" had been an accident of whatever handle setup happened to create.
Smoke-tested against a live Postgres: all ten start and stop cleanly in ~0.5s,
and a teardown that never resolves exits at 15.3s.

Separately, `pnpm dev` started **seven** of the ten workers. calendar, microsoft
and push each have a dev script and a production container and had simply never
been added to the list, so three ingest paths were dark locally while looking
fully wired.

**A deleted git worktree destroyed the local database, and could again.** The
dev stack mounts `${MANTLE_DATA_DIR:-./data}/postgres` relative to compose's
working directory, and the project name is pinned — so running it from a
worktree does not give you a separate stack, it gives you the SAME containers
pointed at a DIFFERENT data directory. A stack brought up inside a worktree put
Postgres' data there; removing the worktree pulled the directory out from under
a running database. `scripts/dev-compose.sh` now resolves the original clone
and operates there, `reset.sh` resolves its wipe target the same way, and the
rule is written into CLAUDE.md. Also `infra:psql` ran `docker exec -it
mantle_pg` — the PRODUCTION container name — so on a host running both stacks it
opened a psql session on production.

**The Runners screen 500'd on a restored brain.** The engine-absent guard knew
42501, 3F000 and 42P01 — all of them about schemas — but DBOS keeps its journal
in a separate DATABASE, and `pg_dump` is per-database, so a brain restored from
a bundle has none and Postgres answers `3D000 invalid_catalog_name`. A
provisioned cluster served by a read-only role says 42501 instead, which is why
the workstation passed and the deployed demo failed.

## 0.216.7: Adding a Microsoft scope quietly killed every older account (branch claude/sharepoint-auth-directory-listing-d78be4)

**A connected Microsoft account had a shelf life measured from the last time we
edited a constant.** Every token refresh asked Azure for the app's *current*
scope list, but on the refresh leg Azure only honours scopes the user actually
consented to — anything beyond that set is not a widened grant, it's a rejected
request. So the day `Mail.Send` joined the list, every account connected before
it stopped being refreshable: `invalid_grant` / `AADSTS65001, the user has not
consented`. The account kept working until its access token expired, then went
dark, and the only cure was a reconnect nobody knew to perform.

The refresh no longer sends `scope` at all — omitting it re-issues exactly the
consented set, which is also what comes back on the response, so the granted
scopes we record (and gate outbound send on) stay accurate. The authorize and
code-exchange legs still ask for everything, because that is where consent is
actually given.

**The failure was also invisible from both ends.** Server-side, the refresh
error was recorded onto `ms_accounts.last_sync_error` *inside* the transaction
it then aborted by rethrowing — the write rolled back with everything else, so
an account that had been failing for a fortnight still read as healthy. It is
now written after the transaction unwinds. Client-side, a token failure threw a
plain `Error` with no status, so the drive browser's "reconnect the account"
branch never fired and the folder picker said only *Could not list the folder.
Try again* — advice that could never work. `invalid_grant` now carries a 401,
which is the branch that tells the truth, and the browse route logs the
underlying Graph error instead of swallowing it.

## 0.216.0: The pictures inside your documents (branch claude/mantle-image-extraction)

**Every parser in the stack was text-only, so a diagram in a Word file or a
screenshot in a PDF manual was dropped on the floor** — invisible to recall and
to display alike. Some answers cannot be described, only shown: a screenshot of
a settings screen *is* the answer to "how do I configure this". Documents now
give their pictures up.

`extractEmbeddedImages` mirrors the text path's three tiers — docx through
mammoth's parsed document, pptx/xlsx/ODF through the zip and its relationship
files, PDF through pdfjs's image XObjects, and the legacy binaries through
Tika's `/unpack/all`, a capability that container always had and we had never
called. Extracted pictures become ordinary image files under
`files/extracted-images/<document>/`, which is what keeps the change small: the
extractor already indexes images (vision describe plus OCR, which reads the
labels *inside* a screenshot), and Pages already embeds a stored image by node
id.

**Reading order is the feature, not a detail.** A manual's screenshots are only
useful in sequence, and listing the media folder gives the wrong answer — part
numbering reflects when a picture was first embedded, and an image reused twenty
times appears once. So each extractor walks the document body and resolves
references to parts: slides in numeric order, sheets in workbook order, pages in
page order. Names follow a cascade of alt text, caption, then nearest heading,
rejecting Office's defaults (`Picture 3`) which look like names but say nothing;
titles carry meaning while filenames stay mechanical and zero-padded, so a plain
listing is reading order and a reworded caption can never orphan bytes.

Retrieval needed one addition. A vision worker looking at a cropped screenshot
writes "a mobile settings screen with several input fields" — true, and useless
for finding it, since nothing there names the manual or the step. Each image
stores its provenance and it is folded in ahead of the vision text, so the
summary, the embedding and the chunks all know where the picture came from.

**No model runs during extraction, and that is the point.** A sixty-slide deck
carries a hundred images — logos, bullets, one icon per slide — and describing
them all would be a hundred LLM calls. Pulling bytes out is free and always
happens; only survivors of deterministic filters (container, pixel dimensions,
byte floor, duplicate collapse, thirty per document) are worth a vision call.
The byte floor is deliberately *low*: flat line art compresses to about 2 KB, and
an initial 8 KB floor rejected precisely the diagrams this exists for. Pixel
dimensions do the real filtering.

Showing one is `show_image` in chat and `![alt](media:<file-id>)` in a page — no
new page machinery, since that syntax already resolved to a stored file. A
`visual_answers` skill carries the judgment: show rather than narrate, put each
step's screenshot beside its step, and never invent a file id. (At the time this
shipped, `show_image` did **not** place a picture where it was called: the chat
surface clumped every image from a turn into a strip below the whole reply. See
"A picture where the sentence needs it" below, which made the inline form work
in chat too.)

SVG is accepted, and is the best case rather than the risky one — vector stays
crisp at any zoom. It is safe because `safeDownloadHeaders` already serves it
under a sandboxed, network-less CSP and both display paths embed through `<img>`,
where SVG scripts never run. Office hides an inserted SVG behind a raster
fallback, so the OOXML walk prefers the vector; without that, an EMF fallback
would be dropped and the diagram would vanish with no error. EMF and WMF
themselves are dropped — no browser renders them — and scanned PDFs are left to
the existing OCR path rather than being mined for "figures" that are really just
pages.

Existing documents are swept by `pnpm -C server/web extract:images-backfill`,
dry-run by default. The documents themselves are free: the image pass sits ahead
of the extractor's already-extracted guard, so no text, summary or embedding
work re-runs.

Fixed while here: `upsertFile` reset a file's title to its filename on *every*
upsert, so any deliberately-titled file silently reverted on re-ingest.

## 0.213.1: The rest of the "all good" over a dead brain (branches feat/healthcheck, feat/sanity-services, feat/test-timeouts)

**Four layers now have to agree before an install calls itself healthy.** The
installer work closed the reporting side; this closes the two places that were
still capable of staying quiet.

**The web container's healthcheck notices it has no network.** When a published
port can't bind, Docker abandons that container's whole network setup and the
process keeps running — attached to nothing, unable to resolve postgres,
unreachable by Caddy. Every HTTP-only check passes there, because 127.0.0.1
_inside_ the container works perfectly. It now asks `os.networkInterfaces()`
for a non-internal interface before asking whether the server answers.
Deliberately not a probe of postgres: Caddy gates on this check, so folding a
peer's health into it would let a routine database restart take the front door
down. "Do I have an interface" answers the real question and depends on nobody.

**The health check names services that were never created.** Everything else
can only judge containers that exist, so a service that failed to be created
dropped out of the report entirely. Removing `tika` from a live stack used to
read "All good — 23 healthy"; it now names it and exits non-zero. Safe because
the expected list honours `COMPOSE_PROFILES` from the install's own `.env` — an
opted-out embedder isn't reported missing, `sandboxd` is expected once
sandboxes are on.

Two bugs surfaced while building it. Repeating a label filter with the **same
key ANDs the terms**, so a query for two compose projects at once matches
nothing — the straggler cleanup in `uninstall.sh` was built on the opposite
assumption and was a silent no-op. And `sanity.sh` derived the stack directory
from its own location while accepting an env-file override, so `--stack-dir`
could read one install's `.env` against another's compose file; it honours
`MANTLE_STACK_DIR` now, and the installer passes it.

**Test timeouts, separately.** Two tests failed the pre-push gate on a green
tree, passed alone in 1.7s, and never failed on macOS. Both load modules
_inside_ the test body, so module resolution and the esbuild transform are
billed against the 5s `testTimeout` — and vitest runs about one worker per
core, so on a 24-core box under real load a `require('mathjs')` costing 411ms
idle sails past five seconds. `testTimeout` is now 15s, and mathjs moved to a
module-scope import so 18MB leaves the per-test budget entirely.

## 0.213.1: An uninstaller, and a project-name bug it exposed (branch feat/uninstall)

**`scripts/uninstall.sh`** — there was no supported way to remove Mantle, so
everyone improvised, and the improvised version is the one that eats a
database. It splits the operation in two, because only one half is reversible.

The default removes containers, networks and named volumes and **keeps your
data**: postgres, the object store, files and backups are bind-mounted into
`MANTLE_DATA_DIR`, and the only named volumes are a tailscale socket and
Caddy's cert cache — so a re-install brings the same brain back with the same
keys. `--purge` additionally deletes the data directory and `.env`, which is
the brain plus `MANTLE_MASTER_KEY`; without that key a vault cannot be
decrypted even from a later backup, so it asks you to type `PURGE` rather than
press `y`. `--dry-run` prints the blast radius and changes nothing, `--images`
reclaims the ~4 GB of pulled images, and the whole thing refuses to run against
the `mantle-dev` development stack or without a terminal to confirm on.
Root-owned data (containers create it as root) is removed via sudo where
available and otherwise through a throwaway container — no password needed.

Writing it surfaced a bug in the installer merged earlier this cycle: port
ownership was keyed on a project name derived from the stack **directory**, but
both compose files set `name:` explicitly, and that wins. On any box not
installed into a directory literally called `mantle`, ownership detection
would have failed and every re-run would have relocated a working front door to
:8080. Now read from the compose file, with compose's own precedence.

Also fixed in both scripts: probing for a controlling terminal leaked
`/dev/tty: No such device or address` onto stderr in a piped or detached run —
redirections apply left to right, so the failure printed before `2>/dev/null`
took effect.

## 0.213.1: Onboarding: orientation before the first message (branch feat/onboarding-tutorial)

**The last screen said "you're all set" and handed you to the assistant.** It
now says what to do with it, in four lines total.

The lead carries the thing that makes the rest cohere and that nobody guesses:
Mantle takes in whatever you give it and indexes it automatically — there is
nothing to tell it to learn or remember. People arriving from chat assistants
go looking for a "remember this" step, and since no builtin exposes that verb,
the search ends in doubt about whether anything was stored at all.

Then three items, and deliberately no more. Files are indexed on arrival, so a
document can be asked about the moment it lands (large ones take a minute —
extraction is a concurrency-capped queue, not an instant embed, and the copy
says so rather than promising magic). Email is gated on the contacts list: no
contacts means nothing inbound is ingested, which is indistinguishable from a
broken mail setup unless you're told it's deliberate — with the real carve-out,
that your own mail always comes in. And everything else happens by asking.

## 0.213.1: Installer: guided setup, honest health checks (branch feat/install-probe)

**An install can no longer report itself healthy when it isn't.** A host port
already holding `:3000` made Docker abandon the web container's entire network
setup; it stayed `running` and `healthy` — its healthcheck only probes inside
itself — with no network, no postgres, and unreachable by Caddy. The sanity
check then confirmed the illusion: it probed `http://localhost:3000` first and
accepted any 2xx–4xx, so the squatter on that very port answered with Mantle's
own `307 → /login`. "All good — 23 services healthy" over a dead brain.

Now: the web container's debug port is configurable (`MANTLE_WEB_DEBUG_PORT`)
and the installer picks a free one; the health check probes the **front door**
and proves Mantle answered via `/api/auth/bootstrap-state` instead of trusting a
status code; a container running with no network or an unbound published port
fails loudly; and the check's verdict is the installer's verdict — a failure
ends in "Installation incomplete" and a non-zero exit.

The front door's host ports moved the same way (`MANTLE_HTTP_PORT` /
`MANTLE_HTTPS_PORT`), because a busy :80 killed a container that matters far
more than the debug tunnel. Without a certificate the installer just moves to
8080 and prints the address with its port; with a domain it refuses to move and
says why — HTTP-01 is answered on 80 and TLS-ALPN-01 on 443, so any other port
means no certificate, ever. `--behind-proxy` covers the box that already runs
nginx: Caddy on loopback:8080, the existing proxy keeps :443.

That also fixed a live bug in `MANTLE_SERVER_ORIGIN`, which the client app
serves to the browser as `apiBase`: it was hardcoded to `http://localhost` for
every non-domain install, so a `--lan` box sent every remote browser's API call
to its OWN machine. It now tracks the address the installer actually tells you
to open, port included.

The installer also asks the question that shapes the install — a domain with
HTTPS, this machine only, or this machine's network — instead of one yes/no
about a domain. `--localhost` binds the front door to loopback
(`MANTLE_BIND_ADDR`), which is the only thing that genuinely keeps a brain off
the network given a published Docker port bypasses the host firewall. A domain
is verified before TLS is enabled — every A **and** AAAA record against the
box's public and local addresses, via getent then dig/host — and a mismatch
offers a re-check, plain HTTP, another domain, or a clean stop rather than
letting Caddy burn that hostname's Let's Encrypt limit; unattended, it falls
back to HTTP instead of proceeding into a doomed request. Prompts read from
`/dev/tty`, so `curl … | bash` can ask real questions instead of answering them
all from an empty stdin. Disk, memory and ports 80/443 are checked before the
~2 GB pull.

## 0.206.1: CLI Sandboxes (branch feat/cli-sandboxes)

**The coder agent gets a computer that isn't the brain's.** Persistent
isolated Ubuntu sandboxes managed by a new `sandboxd` supervisor (the third
docker-socket holder, fixed-verb by construction), opt-in per box behind the
`sandboxes` compose profile: clone and explain a repository, evaluate
untrusted code, build a service — with the work in a `/files` host dir that
outlives the container. Services published from a sandbox become normal
integration tool groups through a bearer-gated proxy (the SSRF guard's one
deliberate, test-pinned exemption); a keyless in-sandbox Claude Code MCP
toolbelt gives structured Read/Edit/Grep/Bash; three egress tiers (`full` /
`balanced` allowlist-proxy / `none`); a batteries-included
`titanwest/mantle-sandbox` base image (~5 s create-to-toolchain); a
`/sandboxes` master-detail surface; and the `sandbox-work` skill so the
grant arrives with its doctrine. Migrations 0138–0139; verified on the
workstation via four tool-layer batteries plus an 8/8 compose-profile demo
([full entry](docs/_changelog/unreleased-cli-sandboxes.md),
[feature doc](docs/sandboxes.md)). Version assigned at the release cut.

## v0.204.0 — 2026-07-26

**The team workspace reads inline — and the split mis-detection is fixed.**
Selecting a shared page, table, note, task, event, file, folder or formula in
`/team` (or the hub) renders the content in the reader pane itself: a new
`GET /s/<token>/view` returns the presenter payload as JSON (same
authorization as the `/s` page, cookie or bearer), and the share presenters
moved to `@mantle/web-ui/share` so both apps render one implementation. No
iframe, no "opens on the brain's own site" card. Pages arrive as
server-sanitized HTML; apps keep their `AppSandbox` execution sandbox.

Underneath sat the bug that produced that card: the client treated
"`MANTLE_SERVER_ORIGIN` configured" as "the API is cross-origin" — but the
installer sets it unconditionally, so **every default one-domain deployment
read as split**: redirect cards instead of content, bearer-only member
sessions, needless SSO detours. `isCrossOrigin()` now compares real origins,
and `POST /api/team/sso` with no `next` answers 204 + Set-Cookie — the silent
bearer→cookie upgrade existing sessions get on their next load. A genuinely
cross-origin client keeps the old top-level SSO behavior. No migrations, no
compose or config changes; e2e 31/0 across both topologies
([full entry](docs/_changelog/0.204.0.md)).

## v0.203.0 — 2026-07-25

**The formulas workbench.** `/formulas` becomes a place you can author a
calculation, not only read one: a signature calling-contract (`signatureOf` —
what must I hand this formula, per target, statically), a guided editor with a
live in-browser validation rail over one form+YAML draft, sharing a formula as
a `/s` live calculator (static equations + warnings render with no JS; only
the calculator is an island), Euler the mathematician specialist, and five
instructional seed formulas that double as the arithmetic regression suite.

Carries two pre-existing **fleet-wide** fixes found en route: copied share
links pointed at the client origin (which does not serve `/s` — broken for
every node type since the member carve), and `client/web` Tailwind never
scanned `packages/web-ui`, so every Switch and Checkbox rendered with no
checked state ([full entry](docs/_changelog/0.203.0.md)).

## v0.202.1 — 2026-07-25

**Release-engineering fix — use this tag, not v0.202.0.** The split's release
matrix (its first real run) collapsed to arm64-only: `platform` lived only in
the matrix `include`, whose entries merge into existing combinations with
later includes overwriting values earlier ones added — so both targets built
arm64 twice, and `mantle-{server,client}:v0.202.0` + `:latest` published as
**arm64-only manifests** unusable on amd64 boxes. (The server image's
`node:sqlite` probe caught it; the client had no such gate and published.)
No code changes vs v0.202.0.

- `platform` is now an original matrix dimension (a true 4-job cross
  product); the `include` entries only attach the runner.
- Two new tripwires in the merge job: exactly one digest per architecture
  BEFORE anything is tagged, and the pushed manifest must list both
  platforms — for both targets, closing the client's gateless publish.

## v0.202.0 — 2026-07-25

> **Do not deploy this tag** — its published images are arm64-only (release
> matrix bug, fixed in v0.202.1). Everything below shipped correctly in
> v0.202.1.

**The server tier runs Hono now — Next.js is removed from `server/web`.** After
the member carve (v0.201.0), `server/web` was an API-first tier: the whole
`/api/**` plane plus a handful of render surfaces, with almost no React left.
Carrying the full Next.js runtime — App Router, RSC, the Edge middleware
sandbox, `next build` — to serve JSON and two static pages was pure weight. So
`server/web` now runs a **Hono app under `@hono/node-server`, executed by
`tsx`** — the same runtime `server/api` and the workers have always used. Boot
is a sub-second `tsx server/main.ts`; there is no compile step. `client/web`
stays a Next.js app, untouched.

- **The gate is a faithful port of the Edge middleware.** Session-HMAC verify,
  the `k:'m'` mobile bearer, `?at=` asset tokens, `PUBLIC_PATHS`, and CORS
  (including the wildcard refusal on the credential-minting `/api/auth/**`
  paths, preflight-before-auth) all moved to `server/middleware/gate.ts`.
  Request path/method now travel via `AsyncLocalStorage` instead of injected
  `x-mantle-*` headers.
- **Route files kept their shape.** A local `NextResponse`/`cookies()`/
  `headers()` compat shim (`server/http-compat/`) and a generated,
  precedence-sorted route manifest (288 `app/**/route.ts` handlers, lazily
  imported and adapted onto Hono) mean the ~280 route files carry the same
  handler convention behind the seam — a mechanical, reviewable diff, not a
  rewrite. Migrating individual routes to native Hono idioms is optional
  future cleanup.
- **Render surfaces are hand-rolled, no Next renderer.** `/s/<token>`
  server-renders via `react-dom/server` with three client islands
  (app/table/token-prompt) bundled into `public/share-runtime/` (Tailwind v4
  CLI compile + esbuild + KaTeX); `/print/pages/<id>` is a plain HTML template
  around `renderPageDoc`; `/login`, `/hub`, `/team/*` are redirect stubs.
- **The HTTP contract did not change.** Same routes and shapes, same port
  (3000), same `/api/health`, and **no new env vars**. e2e is green in both
  topologies (29 passed / 0 failed), with SSE client-abort, 8 MB multipart
  upload, and share-asset `Range` verified live under the node server.
- **The Docker server image drops the compile step**: `build` is asset
  generation only (app-runtime, route manifest, share-runtime), and `CMD` is
  the exec form `pnpm -C server/web exec tsx server/main.ts` — exec, not the
  run-script form, so `SIGTERM` reaches the server instead of dying in the
  package-manager wrapper (`docker stop` settles in ~0.2 s rather than burning
  the full 10 s grace and taking a `SIGKILL`). The client target is unchanged.
- **`pnpm dev:fe` now runs `client/web`.** The client app is zero-secret and
  natively detached, so the old bearer-minting machinery is gone — you sign in
  on the login page. Config moved to `client/web/.env.detached.local`
  (`MANTLE_REMOTE=…` only; the legacy `server/web` file auto-migrates). The
  remote box must allowlist your dev origin (`http://localhost:3000`) in
  `MANTLE_API_CORS_ORIGINS` — the wildcard never covers `/api/auth`. See
  [`docs/db-less-dev.md`](docs/db-less-dev.md).
- **Scheduled backups work again on PostgreSQL 18 boxes.** The image shipped
  the PostgreSQL 17 client, and `pg_dump` refuses to dump a server newer than
  itself — so from the moment a box moved to pg18, every scheduled backup
  failed silently. The image now ships the **18** client (a newer `pg_dump`
  handles older servers, so pg17 boxes are unaffected). After upgrading, run
  one manual backup (Settings → Backups) to confirm the pipeline is alive.
- **Migration guide:** [`docs/upgrading-to-v0.202.md`](docs/upgrading-to-v0.202.md)
  — the full path from the single-image era to the split (DNS, env additions,
  compose adoption, per-box smoke checklist, the pg17-era notes, rollback).
- **The runtime moves to Node 26** (`26.5.0`, V8 14.6) — base image
  `node:26-slim`, `engines: node >=26`, `.nvmrc` and CI matched. Node 26 is the
  *current* line, not yet LTS; it promotes around Oct 2026, so until then this
  pin rides ahead of LTS deliberately, for the V8 and stream performance work.
  Nothing in the application tree needed changing: the only native/wasm
  dependencies (`@napi-rs/canvas`, `libsodium-wrappers`) are N-API/wasm and
  survive the ABI 147 bump untouched, and the `node:sqlite` engine probes that
  back Tables v2 and the per-app broker — the exact things a runtime bump would
  break — pass unchanged.
- **The image's base OS moves with it: Debian 12 (bookworm) → 13 (trixie)**,
  since that is what `node:26-slim` is built on. This broke the image build
  until fixed: the PostgreSQL apt repo line hardcoded `bookworm-pgdg`, which
  does not resolve on trixie, and `apt-get install postgresql-client` failed
  outright. The codename is now **derived from the base image**
  (`. /etc/os-release` → `${VERSION_CODENAME}-pgdg`) so the next base bump
  can't reintroduce it. Anything else that assumes bookworm package names in
  an image layer is worth a second look.
- **The brain's appearance is server-rendered — one delivery path.** The
  colour theme + the two display fonts (system-wide: they live on the anchor
  owner's profile row, so one admin choice brands every surface and every
  browser) now render straight into the `<html>` tag as attributes + inline
  font vars, everywhere: the client app's root layout fetches the new public
  `GET /api/appearance` server-to-server (30s cache, 2s timeout, fail-soft —
  a page never fails over branding) and the share/print surfaces read the DB
  directly. The old localStorage before-paint scripts are DELETED, not
  coordinated with: the document arrives correct, the client providers read
  the attributes back as initial state, and the theme-flash on a
  never-visited browser (which the client-origin split would have made
  universal) is gone. Semantics: share/print surfaces are the brain's brand —
  the owner's appearance is the only appearance, including branded PDF
  exports (still forced-white paper); a default choice is the absence of the
  attribute. The font picker also gains a home it never had: Settings →
  Appearance → Typography (it was previously mounted only on an unrouted
  demo page, so display fonts could not be set from the UI at all).
- **Footprint** (measured back-to-back on one host, idle boot): server image
  **1.81 GB, down from 2.01 GB** (the `.next` output is gone); settled RSS
  ~**643 MB vs ~683 MB** under `next start`; boot-to-ready ~3.2 s vs ~2.4 s —
  the +0.8 s is tsx transpiling TypeScript at startup (the same trade
  `server/api` and every worker already ship with), not request-path cost.
  The multi-minute `next build` disappears from the image build entirely.

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
