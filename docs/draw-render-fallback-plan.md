# Draw: server-side render fallback (plan)

> STATUS: proposed, not built. Follows [draw-plan.md](./draw-plan.md) and the
> audit in [draw-audit-findings.md](./draw-audit-findings.md). Scope is P0 (a
> render fallback) and P1 (engine versioning + a re-render maintenance task).
> P2 (embedding a drawing in a page) and P3 (`file_refs` integrity) are noted at
> the end but are not part of this plan.

## 1. The problem, stated precisely

`draws.scene_svg` is currently **load-bearing**. Every surface outside the
editor renders it, and the only thing that can produce it is a browser with the
scene open, because Excalidraw cannot run outside a browser (text layout depends
on real font metrics: `measureText`, `document.fonts`, `getBoundingClientRect`).

So an absent snapshot is a permanent dead end, and that single property causes
four separate problems:

1. **Phase 6 (agent authoring) is blocked.** A drawing created by a tool has no
   browser in the flow, so it can never have a preview, a share render or an
   export until a human opens and commits it.
2. **The corpus cannot be re-rendered.** An Excalidraw upgrade, a font change or
   a theme decision requires every drawing to be opened and re-committed by hand.
3. **"Committed but blank" is unrecoverable.** The audit fixed the two ways to
   get there silently, but the state itself still has no repair path.
4. **There is no answer to a bad upgrade.** Kill criterion 3 in the original plan
   asks for scene-corruption safety across an upstream bump, with no mechanism to
   act on the answer.

## 2. The principle

**`scene_svg` stops being a source of truth and becomes a cache.**

The client capture at commit stays exactly as it is and remains the fast path,
covering essentially every human-authored drawing. Nothing on the hot path gains
a Chromium dependency: rendering a share page stays a single database read. The
only change is that a cache *miss* becomes fillable instead of fatal.

This is not a reversal of the original decision to keep Excalidraw out of the
server. It is a fallback for the cases that decision never covered.

## 3. Where the render page lives, and why

**In `server/web`, not `client/web`.** Four independent reasons, each verified:

- Production compose (`docker-compose.yml`) defines `web`, `api`, `caddy`,
  `browser` and the workers, but **no `client` service**. The owner UI ships as a
  separate image (`--target client`) and may not be deployed beside the brain at
  all. A render path that depends on the client origin being up is not safe.
- The sidecar reaches the app at `printOrigin()`, which is `http://web:3000` in
  prod compose. That is `server/web`.
- `server/web` already ships browser bundles. `scripts/build-share-runtime.ts`
  runs esbuild three times today (`islands.js`, a mermaid IIFE, `diagram-theme.js`).
- **The precedent is exact.** The mermaid IIFE bundle exists so that a heavy,
  browser-only rendering library can be self-hosted and executed *inside the PDF
  sidecar's Chromium* to upgrade a print surface. That is precisely the shape of
  this work.

The image cost is already paid: the Dockerfile does a full workspace install and
runs TypeScript via `tsx` without pruning, so `@excalidraw/excalidraw` is already
present in the image through `client/web`. Adding it to `server/web` is a
workspace edge, not 47 MB of new bytes.

## 4. P0: the fallback

### 4.1 The render island

New esbuild entry `server/islands/draw-render.ts` → `public/share-runtime/draw-render.js`.

It does **not** mount `<Excalidraw />`. It imports only `restore` and
`exportToSvg`, which are standalone functions, so the bundle carries the renderer
and roughjs but none of the editor UI, and needs no React. Measure the output at
build time and record it here.

Contract with the page:

```
window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'   // set BEFORE import
window.__mantleDrawScene                               // injected by the route
  ↓
restore() → exportToSvg({ renderEmbeddables: false, exportEmbedScene: false })
  ↓
window.__mantleDrawSvg  = svgEl.outerHTML
window.__mantleDrawDone = true          (or __mantleDrawError = '<message>')
```

`renderEmbeddables: false` is mandatory here for the same reason it is in the
editor: without it an embeddable renders as `<foreignObject>` and the result is
rejected downstream.

### 4.2 The route

`GET /render/draws/:id` in `server/web/server/pages/`, `requireOwner`, mounted
beside `/print/draws/:id` and never linked from the UI.

It serves a minimal HTML document embedding the **committed** scene and the
island. The scene is injected as JSON into a script tag, so it must be escaped
against `</script>` and `<!--` sequences. This is the same class of bug as the
SVG one the audit found, data becoming code, and it gets the same treatment:
serialize with an escaping helper, and unit-test the helper directly.

### 4.3 The driver

`server/web/lib/render-draw-svg.ts`, a sibling of `render-pdf.ts` reusing its
conventions: `puppeteer.connect` to `BROWSER_WS_ENDPOINT`, forward the internal
render cookie, `page.goto`, `waitForFunction` on the done-or-error flag with a
timeout, `page.evaluate` to read the string, disconnect in a `finally`.

Unavailability is an expected condition, not an exception: mirror
`PdfRendererUnavailableError` so callers can degrade rather than 500.

### 4.4 Where the fallback is allowed to fire

This is the security-relevant decision. Rendering spawns a browser, so an
anonymous request must never be able to trigger one.

| Caller | On cache miss |
|---|---|
| `/s/:token/draw` (public share) | **cache only**, placeholder on miss |
| Owner list preview, export, print | may fill the cache |
| `draws:re-render` maintenance task | fills in bulk, bounded concurrency |

The public share surface therefore stays a pure database read, exactly as today.
A shared drawing that has never been rendered gets filled by the owner visiting
it or by the maintenance task, not by its audience.

### 4.5 Layering

`packages/content` is browser-free and must stay that way, so the fallback does
**not** go in `packages/content/src/draws.ts`. The pure `getDrawSvg` keeps its
current meaning ("what is stored"), and `server/web/lib/draws.ts` gains
`getDrawSvgOrRender(ownerId, id)` that wraps it. Only the owner-side routes call
the wrapper.

Two supporting pieces:

- `setDrawSvg(ownerId, id, svg, engine)` in `packages/content`. It writes the
  snapshot and the engine stamp **only**: no version bump, no `draft_rev`
  change, and above all **no `notifyNodeIngested`**. Filling a cache is not a
  content change, and re-rendering a corpus must not re-run the extractor over
  it. (House rule: never add a trigger that can cause runaway LLM runs.)
- The rendered SVG goes through `acceptSceneSvg` like any other, defence in
  depth, even though this one came from our own sidecar.

### 4.6 Concurrency and failure

An in-process in-flight map keyed by node id collapses duplicate concurrent
misses into one render, plus a small semaphore (start at 2) so a burst cannot
saturate the sidecar. Chromium is the scarce resource, not us.

Every failure path degrades to the current behaviour: sidecar unconfigured,
sidecar down, timeout, or a snapshot that fails validation all return null, and
the caller shows the placeholder it already shows today. No new 500s.

### 4.7 Fonts: the subtle one

`exportToSvg` inlines the fonts it uses by fetching them from
`EXCALIDRAW_ASSET_PATH`. Today `copy-excalidraw-assets.mjs` syncs them into
`client/web/public/excalidraw-assets/fonts` only; `server/web/public` has no
copy. If the sidecar renders without them, the fallback silently produces a
snapshot in fallback fonts that does not match the client's.

So the copy script must also target `server/web/public`, wired into that app's
`prebuild`/`predev`. This mirrors the existing house rule for display fonts,
where each app serves its own copy of the woff2 files.

## 5. P1: engine versioning and re-rendering

**Migration 0146**: `ALTER TABLE draws ADD COLUMN svg_engine text;` nullable, no
backfill (null means "produced before we tracked it", which is a valid miss).

Written on both paths, the commit and the fallback. A single exported constant
holds the pinned version, with a **tripwire test** asserting it equals the
installed package's version, so bumping the pin without bumping the constant
fails CI. The repo already uses this pattern (`kit.test.ts`, `display-fonts.test.ts`).

`getDrawSvgOrRender` then treats an engine mismatch as a miss, so an upgrade
heals lazily as drawings are viewed.

**Maintenance task** `draws:re-render`, registered in
`server/web/lib/maintenance/registry.ts` next to `re-embed`, backed by
`server/web/scripts/draws-re-render.ts`. Same shape as its neighbours:
`kind: 'ops'`, `schedulable: false`, a `--dry-run` flag, `--stale-only` (engine
mismatch or null) versus `--all`, and bounded concurrency. Cost is browser time,
not tokens.

This is also the concrete answer to kill criterion 3 and gap G2: the pin-bump
test becomes "re-render the corpus on the new version and diff", and if an
upgrade does change rendering, the recovery is a task rather than a support
incident.

## 6. Testing

- **Unit**: the script-tag escaping helper (`</script>`, `<!--`, unicode line
  separators); the engine-version tripwire.
- **e2e**: the hermetic stack already runs a `browser` service, so this is
  testable end to end. Extend `e2e/specs/draws-crud.spec.ts`: commit with a
  snapshot, clear `scene_svg` directly, request the SVG export as the owner, and
  assert it comes back non-empty and that a second request is served from the
  cache. Add the negative too: the same node over `/s/:token/draw` while the
  cache is empty must 404 rather than render.
- **Manual, once**: confirm a sidecar-rendered snapshot is visually equivalent to
  the client-rendered one for the same scene. This is the font check from §4.7
  and it is the thing most likely to be quietly wrong.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Sidecar render differs from client render (fonts) | Ship the same woff2 files to `server/web/public` (§4.7); verify once by eye |
| A burst of misses saturates Chromium | In-flight dedupe + semaphore (§4.6) |
| Anonymous share traffic triggers renders | Public route is cache-only by design (§4.4) |
| Re-render storm re-runs the extractor | `setDrawSvg` never notifies (§4.5) |
| Scene JSON injected into a script tag | Escaping helper + unit test (§4.2) |
| `packages/content` gains a browser dependency | Fallback lives in `server/web` only (§4.5) |

## 8. Non-goals

- **The sidecar does not become the primary path.** The commit-time capture stays
  the fast path; the speed and determinism it buys are the reason the design is
  good.
- **No jsdom or SVG-rasterizer rendering in Node.** Text metrics would be wrong,
  and wrong quietly, on some diagrams rather than loudly on all of them.
- **No PNG alongside the SVG**, and no second renderer of any kind.

## 9. Sequencing

P0 first and whole: it is what unblocks everything else. P1 lands directly on top
and shares the write path, so the two are one work item in practice. Then, on
separate merits:

- **P2**: let a page embed a drawing (a `draw:` href scheme, an editor node, and
  DOCX embedding through the existing image loader). The biggest user-facing gap,
  and cheap once a snapshot is guaranteed to exist.
- **P3**: `file_refs` integrity. Deleting a pasted image empties it from the
  canvas while the snapshot keeps showing it, because images are inlined as data
  URLs at export. With P0 in place the fix is a re-render rather than a guard.
