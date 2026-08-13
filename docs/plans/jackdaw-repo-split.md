# Jackdaw repo split: frontend out, brain standalone

**Goal.** Split the frontend into its own parent repo, **jackdaw** (the
data-aware workspace, the interface), leaving **mantle** as the server brain:
the memory system, ingest, workers, and the HTTP/MCP API. This also formalises
the second consequence of the FE/BE split: a Mantle brain is deployable
headless, as a small memory core with no UI at all.

Status: **plan**, written 2026-08-13 from a fresh audit of `main` at v0.230.27.

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

### P1: publish the contract

- CI publishes `@mantle/contract`, `@mantle/content-core`,
  `@mantle/voice-client` to npm on every release tag (they version with the
  server).
- Server exposes its contract version at `/env.js` (or `/api/health`); the
  client already reads `/env.js` per-request, so the handshake ride-along is
  cheap.

### P2: cut the repo

- `git filter-repo` (path filter: `client/`, `packages/web-ui/`, UI e2e) into
  the new `jackdaw` repo, preserving history. mantle deletes those trees in the
  same release.
- jackdaw swaps `workspace:*` for pinned npm versions of the three contract
  packages; gets its own version stream, changelog, `verify`, and CI building
  the `mantle-client` image (rename to `jackdaw` image at this point) and the
  Electron desktop builds.
- The theme generator moves with `web-ui` (themes are a UI concern; the seeds
  and `themes:build` go to jackdaw).

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
