# Small helpers and process plumbing

Arch plan v2, A10 #15 (gateway survey finding 15). Nine small things were
written by hand all over the repo. Each now has one home, and each hand copy
is counted by [`eslint-rules/std-helpers.mjs`](../eslint-rules/std-helpers.mjs)
and pinned in `scripts/arch-scoreboard.pins.json`, so a count can only go
down. The method was the A4/A5/A10 one: record the answers on main
(v0.300.63), move, compare, and name every cell that changed.

## The homes

| What             | Home                                                                          | Before (main)                                   | Now                                        |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| UUID regex       | `UUID_RE` / `isUuid`, `packages/std/src/index.ts`                             | 34 copies outside std (+4 named)                | 0 (+4 named)                               |
| Error to message | `errorMessage`, `packages/std/src/index.ts`                                   | 139 hand ternaries                              | 116, every one named with its reason       |
| Tag normaliser   | `dedupeTags`, `packages/content/src/tags.ts` (`@mantle/content/tags`)         | 12 copies                                       | 1                                          |
| Signal handlers  | `onShutdown`, `packages/std/src/shutdown.ts` (`@mantle/std/shutdown`)         | 5 handlers in 3 processes, one with no deadline | 0 (+1, the helper)                         |
| Advisory locks   | `advisoryXactLock`, `tryAdvisoryXactLock`, `packages/db/src/advisory-lock.ts` | 10 inline (+3 named)                            | 0 (+5 named: the helper's 2, share, tests) |
| TTL caches       | `TtlCache`, `packages/std/src/ttl-cache.ts`                                   | 14 hand age checks (16 with the model explorer) | 9, all named (1 is TtlCache's own)         |
| Cache-Control    | the gate's default and `CACHE_CONTROL`, `server/web/lib/cache-control.ts`     | 76 literal values in 57 files                   | 0 literals; 44 files name the header       |
| Logging          | `log(scope)`, `packages/tracing/src/log.ts`                                   | 509 console calls outside scripts               | 473 (pinned, down only)                    |
| Live workspace   | `liveWorkspace` and twins, `packages/db/src/workspace-live.ts`                | 26 in SQL, 10 drizzle `isNull`                  | 2 (a plain string, a postgres.js fixture)  |

Not in std, as the survey had it: the advisory lock (std takes no dependency
and is bundled for the browser; a lock needs drizzle and a transaction) and
the live workspace helpers (the same). The tag normaliser is a content rule, so it
lives in the content package.

## UUID_RE

Every anchored copy outside std imports `UUID_RE`. Named: the published
contract package content-core keeps its two (it takes no dependency) and
sandboxd keeps its own (no workspace dependency). The case-sensitive copy
in `packages/content-core/src/app-nav.ts` now reads either case, as std's
does. Its one caller (`asId`) lower-cases the id before it tests, so no id
reads otherwise and no comparison changes; `app-nav.test.ts` holds an upper
case id to its lower case answer, and the test passes on main too. The
inline case-sensitive test in `packages/content/src/member-accepted.ts`
lower-cases first as well.

## errorMessage

The codemod took the sites whose fallback is `String(err)`, and `err` inside
a template literal (which stringifies the same). The sites left are named,
file by file, in `ERROR_IDIOM_ALLOWED`:

- the fallback is the value itself, a console argument: a non-Error object
  logs as itself, where `errorMessage` would log `[object Object]`;
- the fallback is a fixed text;
- the file cannot import std: a published contract package, `@mantle/config`,
  std itself, a repo script, the drawing renderer's bare worker thread;
- `server/web/lib/runners.ts`, whose local `errorMessage` has another meaning.

The voice adapters waited for feat/anthropic-ws and folded in fix round 1:
`spend.ts` takes `errorMessage`; `openrouter-chat.ts` imports `sse.ts`'s
`safeDelta` in place of its own copy (named change: that warning's prefix
reads `[chat-stream]`, as every other stream's); `sse.ts` (the value itself)
and `openrouter-tts.ts` (a fixed text) are named. `metrics.ts` held no hand
idiom.

`errorMessage` also notes a database error's text while a caller outside the
server is served (`watchDatabaseErrors`), so a tool reply that repeats it is
answered generically. That is the point of it; the 21 moved sites now take
part.

## Shutdown

`onShutdown` installs SIGINT and SIGTERM. The first signal logs, arms the
exit deadline, runs the teardown and exits 0. A teardown that throws is
logged and the process still exits; one past the deadline exits with the
deadline code. A second signal while stopping is ignored.

| Process                                   | Main (v0.300.63)                                                             | Now                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| API (`server/api/src/main.ts`)            | guard; no deadline (a hung pg-boss drain or DBOS held the process); exit 0   | **45 s deadline, exit 1**; a teardown failure is logged |
| Web server (`server/web/server/main.ts`)  | no guard: **a second signal closed again and exited 0 at once**; 5 s, exit 0 | a second signal is ignored; 5 s, exit 0                 |
| Workers (`server/web/workers/_runner.ts`) | guard; 15 s, exit 1; "shutting down…"                                        | the same; the log line loses its ellipsis               |

The API's deadline is 45 s: pg-boss drains in-flight jobs for up to its own
30 s graceful stop, then DBOS stops. Docker sends SIGKILL after a
container's `stop_grace_period`, 10 s when unset, so `docker-compose.yml`
names one past each deadline (fix round 1): the API 50 s, each of the ten
workers 20 s; the web server's 5 s fits the default.
`packages/config/src/compose-env.test.ts` reads the deadlines from the
source and holds each grace period past its own. A box takes the new grace
periods at its next roll (the updater recreates the containers with a plain
`compose up -d`, which honours them; `scripts/roll.sh` sets no stop
timeout). The autoheal sidecar's restart of an unhealthy container keeps its
own 10 s: that container is wedged, not draining.

## Advisory locks

A lock's key is the hash of a key text, and two hash functions are in use:
`hashtextextended(text, 0)` (64 bit) at six sites and `hashtext(text)` (32
bit) at four. Each site keeps its own. Two versions of the code exclude each
other during a roll only when both hash the same text with the same
function, so changing a site's hash would let an old and a new process hold
"the same" lock at once. A new lock uses `hashtextextended`.

The proof: `packages/db/src/advisory-lock-keys.test.ts` recorded every
site's lock function, hash and key text on main (it reads either form, the
inline SQL or the helper call, and ran on both); the unit test renders the
helper's SQL as main wrote it; `packages/db/src/advisory-lock.db.test.ts`
takes main's inline lock and the helper's lock on a real Postgres, site by
site, and finds the same `pg_locks` key, and a held main lock refuses the
helper's try. Two keys that were SQL literals (the entity dedupe sweep, the
snapshot copies) are a parameter now: the same text, the same hash.

The folder-share lock keeps its own SQL (its key is a SQL function the
triggers share, and it is shared); test support keeps a session lock.

## TtlCache

The decision cache of `@mantle/decisions` made general: fresh while the age
is under the TTL (a set may name its own), a stale entry dropped when read,
`peek` for a reader that serves the last value while a refresh runs (the
entry whatever its age, and whether it is fresh; it drops nothing), an
optional least recently used bound, `prune`. The freshness rule is one
private method. Moved: the decision cache (it extends TtlCache; its key
hash stays in decisions, which may use node:crypto), the decider lookup,
the embedding config, the dashboard bundle, the turn deduplication, the
embedder health probe, and (fix round 1, once feat/anthropic-ws landed)
the model explorer's provider lists and their failure backoff.

The model explorer keeps its behaviour: one fetch per slot at a time (its
in-flight map), the dashboard's background path backs off 5 minutes after
a failure, the owner's fetch is never held back and its success clears the
mark, and the dashboard reads a stale list (`peek`) while its one refresh
runs. `model-context-window.test.ts` holds a stale list through a failed
refresh; it passes on the code before the fold too.

Named and left: the services file (one slot, in `@mantle/config`, which
takes no std), the provider alert state and the OAuth client token (a clock
each call passes in), the search scope counts (cleared whole past 500, not
least recently used), the OpenRouter catalog itself, and three the syntax
tree count found in fix round 1: the app restore marker and the thumbnail
failure marker (a file's age on disk, shared by every process, not an
in-process cache) and the update check (one slot whose age runs from the
check's own stamp, taken before the fetch and served to the page, its TTL
chosen by the answer).

Named change: a decision exactly 10 minutes old is stale now; main held it
until it was older (`age > ttl` against `age >= ttl`). Every other moved
cache used `age < ttl` for fresh already.

### The OpenRouter catalog

One cache, one TTL: 6 hours (`packages/tracing/src/model-context.ts`).
`model_catalog` and the pool fit check read it (`openRouterCatalogRows`),
where the curation tools kept a copy of their own for 5 minutes and fetched
the same 581 rows again. Nothing needs fresher: the curation pass is daily,
and a just-listed model shows within 6 hours. Named changes:

- `model_catalog` serves the last good rows through a failed refresh (main:
  an error once its 5 minutes ran out);
- its first load allows 25 s, as on main (fix round 1); every later
  refresh has the catalog's 8 s, the last good rows serving meanwhile; a
  first load that joins a shorter refresh in flight, which lands nothing,
  tries once more with 25 s;
- a refresh's failure text is `OpenRouter /models returned <status>: <body>`
  in the tracing log as well (the tool's error text is as main).

The model explorer (`server/web/lib/model-explorer.ts`) still fetches the
catalog for its own page: its Refresh button must reach OpenRouter at once,
which the 6 hour catalog would not, and its errors are the provider errors
of the other providers' lists. Its cache is a TtlCache (above).

## Cache-Control

The gate's default (`apiCacheDefault`, `server/web/server/middleware/gate.ts`,
mounted just before the gate): an /api answer that names no Cache-Control
answers `no-store`, whatever made it (a handler, a gate refusal, the error
or not-found answer). It never overrides one. Any other policy, and every
surface outside /api, names its value from `CACHE_CONTROL`; no file writes a
literal.

The plain /api `no-store` sets went (the default gives them), except on the
answers that carry a credential: a minted key, a token refresh, a pair code,
an OAuth registration and its consent page, the member MCP setup. Those keep
`CACHE_CONTROL.none` themselves, so a handler test or a mount outside the
gate keeps it.

The proof: `server/web/server/a10-cache-sweep.test.ts` drove every route,
method and admitted credential on main (1505 cells, the body sweep's
stand-ins and valid bodies) and recorded the status, content type and
Cache-Control. At the move 793 cells answered otherwise, every one an /api
answer that had no Cache-Control on main and answered `no-store`; they are
listed in `server/web/server/__snapshots__/a10-cache-sweep-changes.txt`.
Every other cell answered byte for byte. Both files are the record, kept as
written. Since fix round 1 the sweep holds a forward rule, so a route added
later (PATCH /api/keys/:id was the first) does not fail it for being new:
every /api cell carries a Cache-Control header, and every cell outside /api
answers as recorded (a cell outside /api added since is reviewed into
`OUTSIDE_API_SINCE`, since nothing gives it a default). The guard sweep files and the /s sweep
snapshot changed by exactly that header on /api cells (35,658 cells
compared, 25,557 gained it, no other difference), and the guard sweep holds
its hand-kept main answers through the same default.

## Logging and the live workspace

`console.*` was not codemodded: the files this step moved by hand (the
decider, the embedding config, the turn route, the maintenance sweeps, the
model catalog, the worker runner, both process entries) log through
`log(scope)`, the same `[scope]` prefix through the one logger. The count
outside scripts is pinned and may only go down.

`liveWorkspaceSql(alias)` writes `<alias>.archived_at is null`, the text the
queries wrote by hand, so every query reads as it did. 23 sites moved. Fix
round 1 added the other two forms of the one rule: `liveWorkspace()`, a
drizzle condition (`isNull(workspaces.archivedAt)`, the same SQL; ten where
clauses moved), and `liveWorkspaceText(alias)` for a plain SQL string (the
workspaces check, whose `w."archived_at" IS NULL` reads `w.archived_at is
null` now: the same column). The pin counts every spelling outside the
helper.

## The pins

| Pin                                    | Value   | Meaning                                                  |
| -------------------------------------- | ------- | -------------------------------------------------------- |
| `std_uuidCopy` / `_allowed`            | 0 / 4   | UUID regex copies outside std / named                    |
| `std_errorIdiom` / `_allowed`          | 0 / 116 | hand ternaries outside the list / named                  |
| `std_dedupeTagsCopy` / `_allowed`      | 0 / 1   | copies / the one                                         |
| `std_signalHandler` / `_allowed`       | 0 / 1   | handlers outside onShutdown / onShutdown                 |
| `std_advisoryLock` / `_allowed`        | 0 / 5   | inline locks / named                                     |
| `std_ttlAgeCheck` / `_allowed`         | 0 / 9   | hand TTL age checks / named                              |
| `std_cacheControlLiteral` / `_allowed` | 0 / 0   | Cache-Control values not from `CACHE_CONTROL`            |
| `consoleCalls`                         | 473     | console calls outside scripts (down only)                |
| `archivedAtIsNull`                     | 2       | a live workspace by hand, outside the helper (down only) |
| `cacheControlFiles`                    | 44      | files that name the header (down only)                   |

Three counts read the syntax tree (fix round 1), so a site respelled is
still counted: a SIGINT or SIGTERM listener on any receiver (`on`, `once`,
`addListener`, `prepend…`), its event a string or a name bound to one; a
Cache-Control header set by a call (`set`, `append`, `header`,
`setHeader`), an object key, a `[name, value]` pair or an index assignment,
whose value is not a `CACHE_CONTROL` member, `API_CACHE_DEFAULT`, a
`cacheHeaders()` call, a choice between such, or a name bound to one; and
an age (`<clock> - <stamp>`) compared with a TTL-ish bound (ttl, max age,
stale, fresh, cache, backoff, expiry, lifetime) or a cache stamp, and an
`expiresAt` against the clock. The limit of the last: an age kept in a
variable and compared later, or a stamp and a bound both named otherwise,
is not seen. The live workspace count reads both spellings, SQL (quoted or
not) and drizzle's `isNull(workspaces.archivedAt)`.

`eslint-rules/std-helpers.test.ts` holds each list to exactly the files
that still have the pattern, each with a reason; the lint rules flag a file
outside a list in the editor.
