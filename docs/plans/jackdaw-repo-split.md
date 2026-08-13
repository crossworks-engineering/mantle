# Jackdaw repo split: frontend out, brain standalone

**Goal.** Split the frontend into its own parent repo, **jackdaw** (the
data-aware workspace, the interface), leaving **mantle** as the server brain:
the memory system, ingest, workers, and the HTTP/MCP API. This also formalises
the second consequence of the FE/BE split: a Mantle brain is deployable
headless, as a small memory core with no UI at all.

Status: **P0 executed** 2026-08-13 (same day; see §3a below for what shipped and
what it taught us). Plan originally written from a fresh audit of `main` at
v0.230.27.

**Product direction that motivates the split** (Jason, 2026-08-13): one hosted
jackdaw should connect to MULTIPLE mantle brains and switch between them — a
brain switcher in the shell instead of one ~220 MB browser tab per brain. The
plumbing already leans this way: the client's only config is
`MANTLE_SERVER_ORIGIN` (read per-request via `/env.js`) and auth is
bearer + CORS, so multi-brain is an origin registry + per-origin token store +
per-origin React Query cache partitioning, not an architecture change. This
lands in jackdaw's own roadmap after P2 (each brain must CORS-allowlist the
jackdaw origin; the P3 handshake becomes per-brain).

---

## 1. Where we actually stand (audit results)

The hard work is already done. The FE/BE split (docs/frontend-backend-split.md,
completed v0.66.x; release machinery v0.200.0) delivered:

- **`client/web` is a zero-secret client.** No `SESSION_SECRET`, no
  `DATABASE_URL`, no server packages in the bundle. All data over
  `apiFetch` + bearer against `MANTLE_SERVER_ORIGIN`. Verified in this audit:
  **zero value-imports** of server packages; every `@mantle/*` import in
  `client/web` is `import type` (erased) or a deliberately browser-safe
  subpath.
- **`server/web` is API-only.** Its `app/` tree holds `api/**`, the `/s/[token]`
  share pages, and `globals.css`. Nothing else server-renders UI.
- **Two images, two composes.** `Dockerfile --target server|client`,
  `docker-compose.yml` (brain) + `docker-compose.client.yml` (UI, one service,
  768 MB cap). The brain compose has **no dependency on the client**: a
  server-only deploy is already a supported topology.
- **DB-less dev** (`pnpm dev:fe`, docs/db-less-dev.md) proves the detachment
  daily.

What still couples the two, and is therefore the actual work of a repo split:

| Coupling | Detail |
|---|---|
| Workspace deps | `client/web` depends on `@mantle/{agent-runtime,content,email,microsoft,voice}` for **types and browser-safe subpaths only** (~20 `@mantle/content/*` modules such as `markdown`, `table-model`, `formula-eval`, `page-diff`; `@mantle/voice/client`). |
| `web-ui` is two things | `packages/web-ui` holds the UI kit (client-only) **plus** shared contract modules that `server/web` imports (`version`, `types/integrity`, `types/maintenance`, `turn-streaming`, `traces-format`, `model-choices`, `slugify`, `runners-types`, `assistant-limits`, `safe-download`). |
| Lockstep releases | `docker-compose.client.yml` pins the **same** `MANTLE_IMAGE_TAG` as the server: "never roll one without the other". A split repo cannot keep that. |
| One version stream | Both apps share the root `package.json` version and one changelog. |
| Shared tooling | eslint rules, e2e suite, theme generator (`packages/web-ui` themes), `pnpm verify`. |

## 2. Target shape

```
jackdaw (new repo)                     mantle (this repo)
├─ client/web        (owner UI)        ├─ server/{web,api,mcp,sandboxd}
├─ client/desktop    (Electron)        ├─ packages/* minus what moves
├─ packages/web-ui   (UI kit + themes) ├─ packages/contract  ← published
└─ e2e UI suite                        └─ compose: brain (+ new core profile)
        │            consumes                   │
        └── @mantle/contract, @mantle/content-core, @mantle/voice-client (npm)
```

- **mantle owns the contract.** The server defines the API, so the wire
  contract packages live here and are **published to npm** on release (the repo
  is public; public npm is fine).
- **jackdaw owns everything rendered.** UI kit, themes, Electron shell, UI e2e.
- Compatibility is a **version handshake**, not lockstep tags.

## 3. Phases

### P0: contract extraction (in-repo, no split yet)

Everything the client needs from mantle gets concentrated into three
publishable, server-free packages:

1. **`@mantle/contract`** (grow the existing zero-dep `@mantle/client-types`):
   absorb every `import type` the client takes from
   `content/email/microsoft/agent-runtime`, plus the contract modules
   `server/web` currently imports from `web-ui` (`version`, `types/*`,
   `turn-streaming`, `traces-format`, `model-choices`, `runners-types`,
   `assistant-limits`, `slugify`). After this, `server/web` drops its `web-ui`
   dependency entirely.
2. **`@mantle/content-core`**: the browser-safe `@mantle/content` subpaths
   (markdown, table-model, formula-*, page-diff/toc/split, journal-options,
   contacts-format, persona-bank, block-ids, doc-to-markdown, ...). Zero
   server deps (no db, no node-only APIs). `@mantle/content` and `web-ui`
   re-export from it so the server keeps one implementation.
3. **`@mantle/voice-client`**: today's `@mantle/voice/client` subpath.

Enforcement: an eslint boundary rule so `client/*` and `packages/web-ui` may
import only `contract | content-core | voice-client | web-ui`. This makes the
split mechanical instead of aspirational, and CI holds the line.

### P0 — SHIPPED 2026-08-13 (§3a: what actually happened)

Four commits on `main`, all green under `pnpm verify`:

1. **`@mantle/content-core`** extracted: 22 browser-safe modules (markdown,
   blocks, page-*, table-model/formula-*, journal-options, persona-bank,
   onboarding-questions, thinking-tiers, contacts-format; deps: marked +
   mathjs only). `@mantle/content` keeps same-named one-line shims, so zero
   server import paths changed.
2. **`@mantle/voice-client`** extracted: providers, catalog (+ DiscoveryResult,
   relocated from discover.ts), audio-tags, 12 model catalogs,
   adapters/{types,retry,registry}. Zero runtime deps. Same shim pattern;
   `@mantle/voice/client` remains as a shim.
3. **Contract modules web-ui → client-types**: version, turn-streaming,
   traces-format, model-choices, slugify, runners-types, assistant-limits,
   types/{integrity,maintenance,sanity}, lib/{safe-download,format-bytes,
   format-datetime}. client-types is now the CONTRACT package (root index
   types-only; subpaths may carry zero-dep runtime).
4. **Row DTOs → client-types**: 33 literal types moved with alias re-exports
   at their old homes; db jsonb/enum shapes hand-mirrored (ToolHandler
   convention); PublicEmailAccount / SyncRun / PublicMsAccount as wire-true
   mirrors (ISO-string dates) with key-set drift guards beside the server
   types. `client/web`'s @mantle deps are now EXACTLY
   `{client-types, content-core, voice-client, web-ui}`.
5. **Boundary enforced in eslint**: the client tier (client/**, web-ui) may
   import only the four split-safe packages — type imports of server packages
   are now hard errors, not allowances; the three contract packages may import
   no @mantle sibling at all.

Learned along the way, feeding later phases:

- **The share/docs surface is the real residual web-ui coupling.** server/web
  imports ~26 web-ui subpaths, all of them the `/s/[token]` share presenters
  (9 node kinds + formula-calculator + view-payload) and the docs/appearance
  rendering (`server/pages`, `server/islands`). Decision needed before P2:
  (a) fork a minimal share-ui into server/web, (b) mantle consumes a published
  jackdaw UI package for share pages, or (c) share pages become a
  server-shipped static bundle built in jackdaw. Until decided, server keeps
  its web-ui dependency for exactly this surface.
- **`@server/*` type reach-through — RESOLVED (v0.230.30)**: all 59 type-only
  imports are gone. ~70 view/query DTOs moved into client-types (journey-format
  moved wholesale; table DTOs live in content-core/table-model beside TableDoc).
  The @server tsconfig alias and the @/* server fallback were deleted from
  client/web, and the eslint rule now bans @server/* outright. client/web no
  longer resolves ANY server/web source.
- Package name: kept `@mantle/client-types` rather than renaming to
  `@mantle/contract` — 51 importing files, zero functional gain; the npm
  publish at P1 can use the existing name.

### P1: publish the contract — SHIPPED 2026-08-13

Two decisions taken (Jason):

- **npm scope: `@jackdaw-run`** — the `@mantle` npm scope is owned by a third
  party (so is `@jackdaw`). Workspace names STAY `@mantle/*` (Mantle is the
  engine scope); `scripts/publish-contract.mjs` renames to `@jackdaw-run/*`
  at publish time and restores the tree afterwards.
- **Share/docs surface: a `packages/share-ui` package that stays in mantle**,
  published like the other contract packages; web-ui/jackdaw consume it. Single
  implementation, dependency direction stays mantle → jackdaw. (This closes the
  last P2 gate decision; the extraction itself is the next work item.)

What shipped:

- `.github/workflows/publish-contract.yml`: on every `v*` tag, publishes
  `@jackdaw-run/{client-types,content-core,voice-client}` (TS source — the
  jackdaw Next app transpiles them like workspace deps). Skips cleanly until
  the `NPM_TOKEN` secret exists. **Jason to-do: create the `@jackdaw-run` npm
  org + an automation token, add it as the `NPM_TOKEN` repo secret.**
- `CONTRACT_VERSION` (integer, bumped only on breaking wire changes) lives in
  `@mantle/client-types/version` and is served by `GET /api/version` as
  `contractVersion`. P3 adds the client-side comparison + banner.

### Share-ui extraction — SHIPPED 2026-08-13 (v0.230.33 + v0.230.34)

`packages/share-ui` exists: the nine /s/<token> presenters, view-payload, the
mini-app sandbox (app-sandbox + app-bridge protocol), page-outline, nav-items,
help-topics, and its own copies of button/input/label + cn. It may import only
client-types + content-core (eslint block), publishes as
`@jackdaw-run/share-ui` with the other contract packages, and both tailwind
builds (`globals.css` @source) and the islands bundle build green against it.
event-time and seven more pure modules (text-colors, search-query,
mermaid-theme, highlight-colors, docs-labels, display-fonts, aside-style)
moved to client-types. Server/web's web-ui imports are now ONLY
`appearance` + `avatar` — the theme-layer question above.

### P2: cut the repo

- `git filter-repo` (path filter: `client/`, `packages/web-ui/`, UI e2e) into
  the new `jackdaw` repo, preserving history. mantle deletes those trees in the
  same release.
- jackdaw swaps `workspace:*` for pinned npm versions of the three contract
  packages; gets its own version stream, changelog, `verify`, and CI building
  the `mantle-client` image (rename to `jackdaw` image at this point) and the
  Electron desktop builds.
- **DECIDED + SHIPPED (v0.230.36)**: the theme system stays in MANTLE, inside
  share-ui — Jason: "a true split means it stays in mantle; MCP agents like
  Claude Desktop can still use the entire theme system where needed."
  appearance, lib/themes, theme-registry.gen, backgrounds, avatar, the
  generator (themes/) and the generated styles/themes.css all live in
  @mantle/share-ui now; `pnpm themes:build` runs there. server/web has ZERO
  web-ui imports and no longer depends on it — the server tier is fully cut
  from the UI kit. Nothing gates P2 anymore.

### P3: replace lockstep with a compat policy

- Client sends its supported contract range; server replies with its version.
  UI shows a "server too old / too new" banner instead of silently breaking.
- Policy: server API is **additive within a major**; jackdaw pins a minimum
  contract version; either side can release freely inside the window.
- Until P3 ships, keep deploying in lockstep exactly as today.

### P4: brain-core deploy profile (headless memory cores)

The brain already runs headless; what is missing is a **small** shape. Today
`docker-compose.yml` always starts all 10 workers plus tika/browser; the mem
caps sum to ~15 GB even though actual RSS is far lower. For "fresh memory core
for meeting recordings" deploys:

- Add a `core` compose profile (or `docker-compose.core.yml`): postgres, minio,
  migrate, web (API+MCP), caddy, and an opt-in worker list
  (files+docs for ingest; api only if chat/runs are wanted; email/telegram/
  microsoft/calendar/push/runs/maintenance off by default).
- Target: a 2 vCPU / 4 GB box with online embeddings (the CPU local embedder
  stays a big-box option, as documented in self-hosting).
- Such a core is reachable exactly like any brain: MCP + HTTP API + federation
  (`mantle_peer`), so a UI-carrying brain can query it as a peer. No
  degradation of the main brain.

### P5: docs + fleet

- README split: mantle = the engine/brain, jackdaw = the workspace on top.
- Update install.sh, fleet deploy scripts, and per-box .envs for the renamed
  client image; keep pulling both stacks per box where a UI is wanted.

## 4. Risks and mitigations

- **Contract drift** across repos: published contract + the existing
  client-types drift checks move into both CIs; add a cross-repo e2e smoke
  (jackdaw@latest against mantle@latest) as a nightly.
- **Dev ergonomics**: losing the monorepo means cross-repo changes need
  `pnpm link` / local file: overrides. Document the two-checkout workflow; most
  changes are one-sided after P0, which is the point.
- **Release friction during transition**: phases P0-P1 are ordinary in-repo
  refactors; the cut (P2) is a single release. Do not start P2 until the eslint
  boundary has been green for a while.
- **Share pages** (`/s/[token]`) stay in mantle and must not regress: after P0
  they may not import `web-ui`; whatever rendering they need comes from
  `content-core` or gets inlined.

## 5. Effort guess

P0 is the bulk (mechanical but wide: ~40 import sites in client, ~50 in
server/web for the web-ui contract subpaths). P1/P3 are small. P2 is a day of
git surgery plus CI. P4 is compose work plus a validation deploy on a small
box.
