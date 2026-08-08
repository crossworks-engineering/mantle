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
render missing some images is *partial* and may only fill an EMPTY cache,
never replace an existing snapshot.

**Validation (`acceptSceneSvg`)**: a committed snapshot is validated
server-side (no scripts, no event handlers, no foreignObject, size cap) and a
hostile payload is dropped, clearing the stored one. It cannot blocklist
`<style>` or element `href`s: every genuine export carries a `style-fonts`
block and element links are a feature. Safety therefore does NOT rest on the
validator being exhaustive; it rests on every surface rendering the snapshot
**as an `<img>`, never inline markup**, with a sandbox CSP on the raw route.

## 5. Where drawings render

| Surface | How |
|---|---|
| `/draw` list + detail preview | snapshot via `/api/draws/:id/svg` (JSON -> blob URL) |
| Page embed | `![alt](draw:<id>)` = an image node with `attrs.drawId`; `<img>` into `/api/draws/:id/svg?raw=1` |
| Share (`/s/[token]`) | cache-only image routes; a shared page serves exactly the drawings its doc places (`referencedDrawIds`), nothing else |
| PDF export | the print sidecar, embeds with `?nofill=1` |
| Markdown / HTML export | the `draw:` reference / an `<img>` |
| DOCX export | **placeholder `[drawing: alt]`** (known gap: `ImageRun` takes no SVG; a PNG raster via the sidecar is the intended fix) |

Embedding in a page has three entry points: the **`/drawing` slash item**
(picker dialog: search, thumbnails, "New drawing" which creates + embeds +
opens the canvas), plain markdown `![alt](draw:<id>)`, and agents writing the
same markdown. The @-mention picker also lists drawings, but a mention is a
link chip, not an embed. Because the embed is live (`src` points at the
drawing's current snapshot), editing the drawing updates every page that
embeds it. On page commit, each embedded drawing's `scene_text` is folded into
the page's indexed text, so a term that appears only inside the diagram still
finds the page.

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
fleet heals lazily on owner views either way.

## 8. Known gaps

- DOCX export degrades to a placeholder (§5).
- Not in `TEAM_WORKSPACE_TYPES` (no `/team/draw`) or `PEER_SHAREABLE_TYPES`
  (not federated by category); both are deliberate small additions when
  wanted, not oversights.
- Creating a drawing fires `node_ingested` via the `nodes` INSERT trigger, so
  a brand-new empty drawing costs one summarizer call.
