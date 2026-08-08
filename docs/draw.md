# Draw: whiteboard workspace

> One Excalidraw scene per item, at `/draw`, alongside Pages and Tables.
> Sketch architecture, whiteboard an idea, and have the drawing land in the
> brain like every other content type: summarized, embedded, chunked,
> searchable, citable, shareable, embeddable in pages.
>
> Companion docs: [`draw-plan.md`](./draw-plan.md) (the original plan and its
> rationale), [`draw-render-fallback-plan.md`](./draw-render-fallback-plan.md)
> (the snapshot/render architecture), [`draw-audit-findings.md`](./draw-audit-findings.md)
> (the security audit that shaped the share surface), [`pages.md`](./pages.md)
> (the sibling workspace whose patterns Draw mirrors).

---

## 1. What Draw is (and isn't)

- Built on the npm package **`@excalidraw/excalidraw`, pinned exact at
  `0.18.1`**. Never a fork; upgrades are deliberate (see §7).
- **Browser-only rendering.** There is no Node path that renders a scene
  correctly: text layout needs real font metrics (`measureText`,
  `document.fonts`). Every non-editor surface renders `draws.scene_svg`, a
  snapshot; when the server itself must render, it does so by driving a real
  Chromium (the browser sidecar) through our own page (§4).
- **No real-time collaboration.** Single-user, self-hosted; the collab module
  is never mounted. The scene is a plain JSON blob.
- **Draft / commit, exactly like Pages.** Autosave writes a private draft;
  only Commit publishes, recomputes derived text, stores the snapshot, and
  fires one `node_ingested`. Drafts are never rendered, indexed, or shared.
- Assets (fonts) are self-hosted under `/excalidraw-assets/`; a self-hosted
  box never fetches from a CDN.

## 2. Data model

A drawing is a `nodes` row of `type='draw'` (ltree root `draw`) plus a 1:1
`draws` sidecar ([`packages/db/src/schema/draws.ts`](../packages/db/src/schema/draws.ts)):

```
draws
  node_id      uuid PK, FK nodes ON DELETE CASCADE
  scene        jsonb  { elements, appState? }  COMMITTED scene (source of truth)
  scene_text   text   derived plaintext (extractor + FTS read this)
  scene_svg    text   snapshot of the committed scene (a CACHE, see §4)
  svg_engine   text   Excalidraw version that produced scene_svg (staleness marker)
  file_refs    jsonb  Excalidraw BinaryFile id -> file node id
  draft_scene  jsonb  autosaved working copy (NULL when nothing uncommitted)
  draft_rev    int    optimistic-concurrency etag (mirror of pages.draft_rev)
```

- `appState` is stored trimmed to a whitelist (background, grid, scroll/zoom).
- **Pasted images never live in the scene blob.** Each becomes a real `file`
  node via the files pipeline; `file_refs` maps them back. They get OCR'd once
  by that pipeline, and their extracted text folds into `scene_text` at commit
  (bounded, same rules as Pages' `foldEmbeddedText`). Deleting a file that a
  committed scene still places is refused with a 409 (`reason: 'in_drawing'`).
- `scene_text` comes from our own pure walker
  ([`packages/content/src/scene-to-text.ts`](../packages/content/src/scene-to-text.ts)):
  frame names as headings, text and labels as lines, labelled arrows as
  `A -> B` relations.

## 3. API + draft/commit

Routes under `server/web/app/api/draws/`: list/create, get/patch/delete,
`[id]/draft` (PUT), `[id]/commit` (POST), `[id]/discard-draft`,
`[id]/svg` (GET). Draft and commit take `if_rev`; a stale etag returns 409
with `current_rev` and mutates nothing. Oversized scenes are refused (413),
not truncated.

The editor (`/draw/[id]`) loads `draft_scene ?? scene` through upstream's
`restore()` on every load, so old scenes are migrated by upstream code, not
by us.

## 4. The snapshot: `scene_svg` is a cache, not a source of truth

The editor captures the SVG client-side at commit (`exportToSvg`) and that
stays the fast path. When the snapshot is missing or was produced by a
different Excalidraw version (`svg_engine`), the **browser sidecar** re-renders
it: `getDrawSvgOrRender` drives Chromium to our own owner-authed
`/render/draws/:id` page, where a small island (no editor UI, no React) runs
`restore()` + `exportToSvg` and hands the SVG back. Same mechanism the mermaid
bundle uses for `/print`.

Three rules, each of which has already prevented (or caused, when broken) a
real bug:

1. **Only owner-authed paths may fill the cache.** Rendering spawns a browser;
   anonymous traffic must never be able to start a Chromium session. The
   public share route is cache-only and 404s on a miss.
2. **Filling the cache never calls `notifyNodeIngested`.** It is not a content
   change; a corpus re-render must not fire one LLM pass per drawing.
3. **Nothing loaded BY the sidecar may trigger a render.** `/print/pages`
   embeds drawings with `?nofill=1`; without it a PDF export deadlocks against
   itself (the sidecar allows 2 concurrent sessions).

Operational details: renders are capped at 2 concurrent, concurrent misses on
the same drawing collapse into one render, and a failed render puts the
drawing in a 5-minute in-memory cooldown so it cannot loop Chromium. Scene
images load 4 at a time with per-fetch timeouts under an overall deadline; a
render missing some images is _partial_ and may only fill an EMPTY cache,
never replace an existing snapshot.

The sidecar has a second, unrelated job: **rasterizing** a snapshot to PNG for
the Word export, since `ImageRun` embeds no SVG
([`server/web/lib/render-draw-png.ts`](../server/web/lib/render-draw-png.ts)).
That is a screenshot of `/print/draws/:id` — the sheet the PDF export already
prints — not a second scene render, so the picture in a .docx is the same
snapshot every other surface serves and cannot drift from it. It runs at 2× for
print, reports its size in CSS px so the document still lays it out at 1×,
shares the same 2-session semaphore, and stores nothing: a raster is a
transient export artefact, never a second cache beside `scene_svg`.

**Validation (`acceptSceneSvg`)**: a committed snapshot is validated
server-side (no scripts, no event handlers, no foreignObject, size cap) and a
hostile payload is dropped, clearing the stored one. It cannot blocklist
`<style>` or element `href`s: every genuine export carries a `style-fonts`
block and element links are a feature. Safety therefore does NOT rest on the
validator being exhaustive; it rests on every surface rendering the snapshot
**as an `<img>`, never inline markup**, with a sandbox CSP on the raw route.

## 5. Where drawings render

| Surface                       | How                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/draw` list + detail preview | snapshot via `/api/draws/:id/svg` (JSON -> blob URL), theme-inverted in dark mode (§5b)                                             |
| Page embed                    | `![alt](draw:<id>)` = an image node with `attrs.drawId`; `<img>` into `/api/draws/:id/svg?raw=1`, theme-inverted in dark mode (§5b) |
| Share (`/s/[token]`)          | cache-only image routes; a shared page serves exactly the drawings its doc places (`referencedDrawIds`), nothing else               |
| PDF export                    | the print sidecar, embeds with `?nofill=1`                                                                                          |
| Markdown / HTML export        | the `draw:` reference / an `<img>`                                                                                                  |
| DOCX export                   | a PNG **raster of the snapshot**, screenshotted off `/print/draws/:id` in the sidecar (`ImageRun` takes no SVG)                     |

Embedding in a page has three entry points: the **`/drawing` slash item**
(picker dialog: search, thumbnails, "New drawing" which creates + embeds +
opens the canvas), plain markdown `![alt](draw:<id>)`, and agents writing the
same markdown. The @-mention picker also lists drawings, but a mention is a
link chip, not an embed. Because the embed is live (`src` points at the
drawing's current snapshot), editing the drawing updates every page that
embeds it. On page commit, each embedded drawing's `scene_text` is folded into
the page's indexed text, so a term that appears only inside the diagram still
finds the page.

## 5a. Editor chrome follows the Mantle theme

The editor's UI is styled entirely by CSS custom properties (the package's
`theme.scss`), and
[`client/web/components/draw/draw-theme.css`](../client/web/components/draw/draw-theme.css)
re-points the chrome-level ones at the app's tokens: islands, menus, dialogs
and the sidebar on `--popover`, hovers on `--accent`, a `--primary`-derived
brand ramp via oklab `color-mix`, and `--ui-font` on the user's interface
font. One selector list covers light and dark (Mantle tokens flip with the
mode; including `.theme--dark` lets cascade order beat the package's own dark
block, which is why the file MUST stay imported after the package CSS in
`excalidraw-canvas.tsx`). Rules are global on `.excalidraw` because dialogs
and tooltips portal to `<body>` outside the canvas wrapper.

Content is deliberately untouched: canvas colors, the drawing palette, label
fonts, selection and the dark `--theme-filter` inversion stay stock, so
committed snapshots do not vary with the app theme. Guarded by
`e2e/specs/draw-theme.spec.ts` (computed-style assertions + a screenshot per
theme in `e2e/.artifacts/`).

## 5b. Why a dark drawing comes back light, and what the previews do

Excalidraw's dark mode is a **CSS filter over the canvas**
(`invert(93%) hue-rotate(180deg)`), not a change to element colours. Draw in
dark mode and the scene stores `#1e1e1e` strokes on a `#ffffff` canvas — the
palettes have no dark canvas swatch and no white stroke swatch — and while the
canvas is inverted the pickers are inverted too, so the "white" you chose is
stored as near-black. `theme` is not in `APP_STATE_KEYS` and both capture paths
pass `exportWithDarkMode: false`, so **no drawing can produce a dark snapshot
by way of the app theme**. That is the intent: the snapshot is served to share
links, PDF, Word and a sidecar re-render that is always light, and it must not
depend on which theme its author had open at commit.

The cost was that the editor inverted and every other surface didn't, which
reads as "my drawing came back in the wrong theme". So the in-app surfaces
apply the same filter at VIEW time
([`client/web/components/draw/snapshot-theme.ts`](../client/web/components/draw/snapshot-theme.ts)):
the `/draw` list and detail previews, and drawings embedded in a page. Nothing
stored or exported changes, and the share surface, `/print` and both exports are
deliberately excluded — they leave the brain, where there is no app theme to
follow.

**A drawing that places pasted images opts out.** Upstream cancels its own
inversion per image element so a photo isn't shown as a negative; one filter
over a flat `<img>` cannot, and rendering the snapshot as inline markup instead
is exactly what §4's security rule forbids. Those keep the light rendition.
The test is `snapshotPlacesImage`, run against the SNAPSHOT rather than
`file_refs` — the snapshot is the thing on screen, so a scene that no longer
places an image it once held gives the right answer, and no surface needs a
database flag plumbed to it.

The two surfaces differ only in how they reach that answer. A preview already
holds the snapshot, so it decides before rendering. A page embed is a plain
`<img>` from a static `renderHTML` (`page-editor/image.ts`) that knows neither
the theme nor the drawing, so it always carries a class ARMED on
`data-draw-theme="invert"`, and `useDrawEmbedTheme` stamps that attribute after
checking the snapshot — re-fetched at the URL the `<img>` already used, so it is
a cache hit, and memoised per drawing. The default is therefore un-inverted (the
old rendering), so a slow or failed check never flashes through a wrong state.

Both classes are written out in full, and must stay that way: Tailwind v4 scans
SOURCE TEXT, so a class assembled from a shared fragment emits no rule at all
and the filter silently does nothing. `snapshot-theme.test.ts` asserts against
the file's own source for exactly this.

A genuinely dark drawing is still available and travels everywhere: set the
canvas background to a dark colour with the custom picker and choose light
stroke colours. Then darkness is data, not a viewer preference.

## 6. Brain wiring + agents

Commit fires `node_ingested`; the extractor reads `scene_text` via
`readNodeBodyRaw`, writes the summary + 768-dim embedding, and chunks come
free over `scene_text`. `search` / `search_chunks` cover drawings; the search
palette and @-mentions know the type.

Agents read via `draw_list` / `draw_get`
([`packages/tools/src/builtins-draws.ts`](../packages/tools/src/builtins-draws.ts)),
which return metadata + `scene_text`. Agent WRITING of scenes is deliberately
not shipped (plan §Phase 6): it would go through Excalidraw's documented
Skeleton JSON, never raw internals, and is a separate decision.

## 7. Operations

```bash
# stale or unrendered snapshots (dry run first)
pnpm -C server/web tsx scripts/draws-re-render.ts --dry-run
pnpm -C server/web tsx scripts/draws-re-render.ts            # heal
pnpm -C server/web tsx scripts/draws-re-render.ts --all      # force re-render

pnpm e2e   # hermetic suite incl. the draw lifecycle; Linux only (needs setsid)
```

**Upgrading the pin**: bump `@excalidraw/excalidraw` (exact), load a corpus of
stored scenes in dev, run `draws-re-render.ts --all`, and diff the snapshots
before shipping. `svg_engine` marks every pre-upgrade snapshot stale, so the
fleet heals lazily on owner views either way. Also re-check `draw-theme.css`
(§5a) against the new version's `theme.scss` — a renamed variable silently
reverts that surface to stock styling (the `draw-theme` e2e spec catches the
two big ones).

## 8. Team + peers

Shared drawings appear in the member workspace (`/team/draw`, via
`TEAM_WORKSPACE_TYPES`) and in the hub stat tiles, and a peer can be granted
drawings by category (`PEER_SHAREABLE_TYPES`, a pinned allowlist whose test
makes widening deliberate). Members and peers only ever see committed
content; drafts stay private.

## 9. Known gaps

- The `export_node` agent tool still writes `[drawing: alt]` into a .docx.
  `resolveExport` takes the raster callback, but `@mantle/tools` has no route to
  the browser sidecar (that lives in `server/web` by design), so only the
  download button injects one. Closing it needs the renderer reachable from
  wherever a tool loop runs, which is more than one process.
- Creating a drawing fires `node_ingested` via the `nodes` INSERT trigger, so
  a brand-new empty drawing costs one summarizer call.
