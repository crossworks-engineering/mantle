# Configuration — environment variables

Every environment variable the server tree reads is listed, by name, in
[`packages/config/src/index.ts`](../packages/config/src/index.ts) (the
`KnownEnvName` union). That file is the inventory; `.env.example` and
`.env.prod.example` are the annotated templates. Read variables through
`@mantle/config` — an ESLint rule refuses `process.env.X` anywhere else in
`server/` and `packages/` (tests and scripts excepted).

```ts
import { env, envNum, feature, isProduction } from '@mantle/config';

const url = env('DATABASE_URL'); // string | undefined, read at call time
const workers = envNum('EXTRACT_CONCURRENCY'); // default and range from ENV_NUMBERS
const on = feature('turnStreaming'); // one switch, one answer (FEATURES)
```

Adding a variable: add its name to the union, document it in `.env.example`,
then read it with `env()`, or register it (a number in `ENV_NUMBERS`, a
switch in `FEATURES`; see "Flags and env" below). A name that is not in the
union is a type error.

Legacy names: the `NEXT_PUBLIC_*` names from the Next.js era are honoured as
fallbacks for their `MANTLE_*` replacements (`ENV_ALIASES` in the same file)
and log one deprecation warning per process. `packages/client-types` still
reads `NEXT_PUBLIC_*` directly because the frontend build inlines those at
compile time; `server/web/server/main.ts` bridges the `MANTLE_*` values into
them at boot.

At start-up both server processes call `assertEnvShape()`, which rejects a
present-but-malformed core value (a non-UUID `ALLOWED_USER_ID`, a
`DATABASE_URL` that is not `postgres://`, a short `SESSION_SECRET`) with every
problem listed. It requires nothing, so DB-less development stays possible.

`server/sandboxd` is a standalone image with no workspace dependencies and
keeps its own config block at the top of `main.ts`.

## Install-time env contract

The variables that decide what a box *is* are written into `.env` by
`scripts/install.sh` and read by compose, the updater sidecar and the sanity
check. The canonical explanation of each is the
[install options page](./guide/01-install/07-options.md); this is the checklist for a
hand-written `.env`:

| Variable | Set by | What it decides |
|---|---|---|
| `MANTLE_SERVER_ORIGIN` | installer | the origin the browser reaches the API on; the owner UI serves it as its API base |
| `MANTLE_CADDY_SHAPE` | installer (`same-origin`) | which `infra/caddy/shapes/*.caddy` the front door imports; `split` needs a second hostname |
| `MANTLE_CLIENT_ENABLED` | `--no-client` writes `0` | whether the owner UI stack runs; missing means on |
| `MANTLE_CLIENT_IMAGE_TAG` | updater (`client-tag.auto`) or a hand pin | the `mantle-client` image tag, on its own stream since the repo split |
| `COMPOSE_PROFILES` | installer flags | opt-in services: `sandboxes`, `media`, `local-embedder`, `helpers` |
| `COMPOSE_FILE` | `--core` | adds `docker-compose.core.yml` as an override (absolute paths, the updater needs them). Compose also hands it, with `COMPOSE_PROFILES`, to web as `MANTLE_COMPOSE_FILE` / `MANTLE_COMPOSE_PROFILES`, so the onboarding check knows a core box without `helpers` sheds Tika on purpose |
| `MANTLE_SETUP_CODE` | installer (generated once, never rotated) | the code first-run signup asks for until the first account exists; web only. `scripts/install.sh --setup-code` prints it; unset means no code is asked for ([onboarding.md](./onboarding.md) section 8) |
| `MEDIA_SIDECAR_TOKEN` | you (`openssl rand -hex 32`) | bearer between the app and the media sidecar; the installer never sets it |
| `SANDBOXD_TOKEN` | installer when sandboxes are on | bearer between web/api and `sandboxd`; never rotated on a re-run |
| `MANTLE_SANDBOXES_HOST_DIR` | installer (`<data-dir>/sandboxes`) | host-absolute bind source `sandboxd` hands to the Docker daemon |

Alongside the five compose refuses to start without (`POSTGRES_PASSWORD`,
`SESSION_SECRET`, `MANTLE_MASTER_KEY`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) and the
address trio (`MANTLE_SITE_ADDRESS`, `MANTLE_PUBLIC_URL`, `MANTLE_STACK_DIR`).

## Flags and env

Every switch and every number the tree reads from the environment or the
profile has one reader, one default and one dialect (workspaces arch A10
#11). Before, 57 number readers and 19 flag readers parsed by hand, the
flags in seven dialects: `'0'` turned one switch off and not its neighbour,
`'off'` another, `''` (what
compose passes for an unset `${VAR:-}`) read as 0 in some number parses and
as the default in others, garbage read as NaN. One variable,
`MANTLE_TURN_STREAMING`, was read twice with two answers: the stream routes
read it raw and ignored the legacy `NEXT_PUBLIC_MANTLE_TURN_STREAMING` that
the replay buffer honoured.

**The dialect** (`packages/config/src/parse.ts`, `parseFlag` and
`parseNumber`): blank (unset, empty, spaces) and unrecognised input mean the
default.

- A flag: `1 true yes on` are on, `0 false no off` are off, any case, trimmed.
  So a default-on switch is an off switch and a default-off switch an on
  switch, from the one rule.
- A number: `Number()` of the trimmed text (`16abc` is not a number, `1e3`
  is 1000), then the registered options in order: `int` (floor or round),
  `positive` and `atLeast` (out of range is the default), `min` and `max`
  (clamped).

**The readers** (`@mantle/config`):

| Reader | Reads |
|---|---|
| `feature(name, ctx?)` | a switch in `FEATURES` (`packages/config/src/features.ts`): an env switch, a profile boolean (`ctx.prefs`), or an optional service |
| `envNum(name)` | a number in `ENV_NUMBERS` (`packages/config/src/numbers.ts`), its default and range from the table |
| `profileFlag(prefs, key)` | a profile boolean with its default from `PROFILE_FLAGS` (`packages/client-types/src/profile-flags.ts`, browser-safe) |
| `envFlag`, `envInt`, `envNumber` | an unregistered name in the same dialect (prefer registering it) |
| `parseFlag`, `parseNumber` | a raw string in the same dialect (the benchmark harness, whose names are data) |

The published contract keeps its own browser-safe readers:
`isTurnStreamingEnabled` / `isTurnStreamingEnabledClient`
(`packages/client-types/src/turn-streaming.ts`, now honouring the legacy name
as `env()` does) and the three profile readers in
`packages/content-core/src/profile-projections.ts` (one line each over
`profileFlag`).

**Features** (`FEATURES`, read with `feature(name)`):

| Feature | Source | Default | What it switches |
|---|---|---|---|
| `turnStreaming` | `MANTLE_TURN_STREAMING (legacy NEXT_PUBLIC_MANTLE_TURN_STREAMING)` | on | live turn stream: the SSE and cancel routes, the non-blocking turn POST, the replay buffer |
| `turnTokens` | `MANTLE_TURN_TOKENS` | on | live reply token typing (needs turnStreaming) |
| `turnNarration` | `MANTLE_TURN_NARRATION` | on | the per-step narration phrases on the stream (a small model call each) |
| `turnSuggestions` | `MANTLE_TURN_SUGGESTIONS` | on | fleet-wide kill switch for the follow-up suggestion (per agent it is opt-in) |
| `queryEnrich` | `MANTLE_QUERY_ENRICH` | on | enrich a short retrieval query from the recent conversation |
| `mcpToolsmithWrite` | `MANTLE_MCP_TOOLSMITH_WRITE` | on | the MCP surface offers the toolsmith write tools |
| `s3ForcePathStyle` | `S3_FORCE_PATH_STYLE` | on | path-style object store URLs |
| `runs` | `MANTLE_RUNS` | off | runner queues: run_plan / run_append and the runs worker (run_state, run_cancel stay live) |
| `viewerRolesPerDatabase` | `MANTLE_VIEWER_ROLES_PER_DATABASE` | off | viewer roles named per database (several brains on one Postgres) |
| `dbRuntimeRole` | `MANTLE_DB_RUNTIME_ROLE` | off | the app pools log in as mantle_runtime, not as the migrator (arch A9, docs/runtime-role.md) |
| `bootReconcileOff` | `MANTLE_DISABLE_BOOT_RECONCILE` | off | skip the system manifest reconcile at production boot |
| `detachedDev` | `MANTLE_DETACHED_DEV` | off (never in production) | DB-less detached dev: page navigations render without a session |
| `crashTest` | `MANTLE_CRASH_TEST` | off | the crash-test harness in server/api |
| `mcpTerminal` | `MANTLE_MCP_TERMINAL` | the caller | the MCP surface offers the terminal tools (default: stdio yes, HTTP no) |
| `shareNeat` | `profile.shareNeat` | on | the public /s share reader paints the saved Neat gradient |
| `streamThoughts` | `profile.streamThoughts` | on | stream the thought trail live while a turn runs |
| `persistThoughts` | `profile.persistThoughts` | on | keep the thought trail on the finished message |
| `toolsmithRequireApproval` | `profile.toolsmithRequireApproval` | off | a tool an agent authors is confirm-gated until the operator clears it |
| `heartbeatEgressGate` | `profile.heartbeatEgressGate` | off | a heartbeat's egress tool calls park for approval |
| `remoteMcp` | `profile.remoteMcpEnabled` | off | the remote MCP connector and its OAuth endpoints answer |
| `teamPrivateReads` | `profile.teamPrivateReads` | off | the team responder may read the owner's email and journal |
| `sandboxes` | `service sandboxes` | Settings > Services | the sandboxes service (sandboxd) |
| `media` | `service media` | Settings > Services | the media sidecar (video_ingest, CAD renders) |
| `localEmbedder` | `service local-embedder` | Settings > Services | the bundled local embedder |
| `docHelpers` | `service helpers` | Settings > Services | Tika and the PDF browser (always on a full box) |

A profile feature is read with the owner's preferences:
`feature('streamThoughts', { prefs })`. `mcpTerminal` takes its default from
the caller: `feature('mcpTerminal', { default: transport === 'stdio' })`.

**Numbers** (`ENV_NUMBERS`, read with `envNum(name)`):

| Variable | Default | Range | What it sets |
|---|---|---|---|
| `MANTLE_SALIENCE_LAMBDA` | 0.15 | any | weight of (1 - salience) added to a hit distance |
| `MANTLE_RECENCY_TAU_DAYS` | 180 | any | recency decay time constant, days |
| `MANTLE_RECENCY_EPISODIC` | 0.15 | any | recency weight for episodic hits |
| `MANTLE_RECENCY_CONTENT` | 0.06 | any | recency weight for content hits |
| `MANTLE_SUPERSEDED_SALIENCE` | 0.5 | min 0, max 1 | salience a superseded node drops to |
| `MANTLE_CORRECTED_SALIENCE` | 0.3 | min 0, max 1 | salience a corrected node drops to |
| `MANTLE_SUPERSEDED_FILE_SALIENCE` | 0.5 | min 0, max 1 | salience of an older version of an exported file |
| `MANTLE_SCOPE_EXACT_MAX_ROWS` | 15000 | whole, min 0 | most rows the exact scope path searches; 0 turns it off |
| `MANTLE_SCOPE_EXACT_MAX_ITEMS` | 500 | whole, min 0 | most items a scope holds for the exact path; 0 turns it off |
| `MANTLE_SHEET_PROFILE_ROWS` | 8 | any | data rows sampled into a sheet's profile chunk |
| `EXTRACT_CONCURRENCY` | 2 | whole, at least 1, max 16 | extractions at once (a saved setting wins) |
| `MANTLE_EXTRACT_EXPIRE_MIN` | 60 | above 0 | extract job expiry, minutes |
| `MANTLE_EXTRACT_DRAIN_WINDOW_HOURS` | 168 | above 0 | how far back the boot drain and the sweep look, hours |
| `MANTLE_EXTRACT_DRAIN_LIMIT` | 1000 | above 0 | boot drain batch |
| `MANTLE_EXTRACT_SWEEP_LIMIT` | 200 | above 0 | periodic sweep batch |
| `MANTLE_EXTRACT_SWEEP_MS` | 120000 | above 0 | periodic sweep period, ms |
| `MANTLE_TABLE_MIGRATE_SWEEP_MS` | 300000 | above 0 | table migration sweep period, ms |
| `MANTLE_MAX_AUTO_TABLE_TABLES` | 20 | above 0 | most tables one auto-table pass makes |
| `DWF_RENDER_DPI` | 300 | rounded, above 0, min 50, max 600 | DWF sheet render resolution |
| `DWG_RENDER_DPI` | 300 | rounded, above 0, min 50, max 600 | DWG render resolution |
| `MANTLE_RUNNER_CONCURRENCY` | 8 | whole, above 0 | in-flight runs on RUNNER_QUEUE |
| `MANTLE_RUNS_TURN_CONCURRENCY` | 2 | whole, above 0 | in-flight runs turns on RUNS_TURN_QUEUE |
| `MANTLE_MEMBER_TURN_CONCURRENCY` | 2 | whole, above 0 | in-flight member chat turns on MEMBER_TURN_QUEUE |
| `MANTLE_RUNS_WORKER_CONCURRENCY` | 3 | whole, at least 1 | running worker items per run |
| `MANTLE_TURN_STALE_MIN` | 30 | above 0 | a pending turn older than this is failed by the reaper, minutes |
| `TEAM_CHAT_DAILY_TURNS` | 100 | whole, above 0 | member chat turns per member login per UTC day |
| `MANTLE_MEMBER_DAILY_TOKENS` | 2000000 | whole, at least 0 | member chat tokens per member login per UTC day; 0 turns the budget off |
| `PORT` | 3000 | any | the port server/web listens on (compose sets it) |
| `MANTLE_RATE_LIMIT_SCALE` | 1 | at least 1 | multiplies every rate limit |
| `MANTLE_TRUSTED_PROXIES` | 1 | above 0, min 1 | proxy hops in front of the server (X-Forwarded-For) |
| `MANTLE_MAX_UPLOAD_MB` | 512 | whole, min 1 | streamed upload cap, MB; 0 or less is 1 |
| `APP_SQL_MAX_DB_MB` | 256 | whole, min 1 | one app database, MB; 0 or less is 1 |
| `APP_SNAPSHOT_MAX_MB` | 2048 | whole, min 1 | snapshot history of one app or table, MB; 0 or less is 1 |
| `APP_SNAPSHOT_AUTO_MAX_MB` | 1024 | whole, min 1 | automatic app snapshots, MB; 0 or less is 1 |
| `APP_SNAPSHOT_MCP_MAX_MB` | 512 | whole, min 1 | app snapshots before an MCP write, MB; 0 or less is 1 |
| `TABLE_HISTORY_MAX_MB` | 512 | whole, min 1 | table edit history, MB; 0 or less is 1 |
| `TABLE_IMPORT_MAX_ROWS` | 2000000 | whole, above 0 | largest table import, rows |
| `TABLE_SQL_TIMEOUT_MS` | 5000 | above 0 | table SQL statement timeout, ms |
| `TOOL_RESULT_INLINE_MAX` | 32768 | whole, above 0 | a tool result up to this many bytes goes to the model inline (per agent overridable) |
| `TOOL_RESULT_EMBED_MIN` | 102400 | whole, above 0 | from this many bytes a stored result is read back by semantic query |
| `TOOL_RESULT_PAGE_BYTES` | 16384 | whole, above 0 | read_result page size, bytes |
| `TOOL_RESULT_SPILL_MAX` | 1048576 | whole, above 0 | a stored result is cut at this many bytes |
| `TOOL_RESULT_MAX_CHUNKS` | 200 | whole, above 0 | chunks embedded per stored result |
| `TOOL_RESULT_TTL_DAYS` | 7 | whole, above 0 | days a stored result is kept |
| `MEDIA_MAX_STT_DURATION_S` | 3600 | whole, above 0 | longest video transcribed by video_ingest, seconds |
| `MEDIA_MAX_AUDIO_BYTES` | 20000000 | whole, above 0 | largest audio track video_ingest sends to speech to text |
| `MEDIA_MAX_VIDEO_BYTES` | 1073741824 | whole, above 0 | largest video video_ingest downloads |
| `MANTLE_LOCAL_EMBED_BATCH` | 16 | whole, at least 1 | texts per request to the local embedder |
| `MANTLE_LOCAL_EMBED_TIMEOUT_MS` | the caller | whole, at least 1000 | local embedder request timeout, ms (default PROVIDER_TIMEOUTS.localEmbed, @mantle/std) |

**What the move changed.** `server/web/server/a10-flags.test.ts` reads every
reader under a matrix of inputs (unset, blank, the flag words, numbers,
fractions, negatives, garbage, legacy-name-only) and compares with the record
taken on main (`server/web/server/a10-flags.main.json`). Every cell that
differs is named, with its reason and the boxes it could reach, in
`server/web/server/a10-flags.changes.json`. In short:

- `MANTLE_TURN_STREAMING` split fixed: a box setting only the legacy
  `NEXT_PUBLIC_MANTLE_TURN_STREAMING` to an off word now has the stream
  routes off as well as the buffer (compose does not pass the legacy name, so
  a dev `.env`).
- Flag words: `MANTLE_QUERY_ENRICH` honours `false`, `no`, `off` (it took
  only `0`); `S3_FORCE_PATH_STYLE` honours `off`;
  `MANTLE_DISABLE_BOOT_RECONCILE` and `MANTLE_CRASH_TEST` honour `true`,
  `yes`, `on` (they took only `1`); `MANTLE_DETACHED_DEV` is on only for an
  on word (any non-blank value turned it on, `0` included); padded values are
  trimmed.
- Numbers: blank, garbage, a negative value where the reader kept it, and a
  fraction that floors to 0 now mean the default; the `parseInt` readers read
  the whole value.

None of these reaches a value compose passes by default: every number and
switch compose passes as `${VAR:-}` reads blank as the default, as before.

**The pins** (`eslint-rules/env-flags.mjs`, `scripts/arch-scoreboard.ts`):
outside a named list, 0 raw `process.env` reads, 0 hand parses of an env
value, 0 `isXEnabled` definitions and 0 profile booleans compared with their
default by hand. The lists name the config module, the boot bridge
(`server/web/server/main.ts`, `server/web/server/env.ts`), the published
readers, `server/sandboxd` (its own config block) and the repo CLIs.
`eslint-rules/env-flags.test.ts` holds each list to exactly the files that
still have the pattern.

Adding a switch: an entry in `FEATURES` (its variable in `KnownEnvName` and
`.env.example`), then `feature('name')`. Adding a number: an entry in
`ENV_NUMBERS`, then `envNum('NAME')`.
