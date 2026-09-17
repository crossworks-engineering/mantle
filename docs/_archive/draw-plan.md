# Draw: whiteboard workspace (implementation plan)

> STATUS: experimental. Lives on `feat/draw-workspace` only; does not merge to
> main until the feature proves itself end to end. This document is the plan;
> it becomes `docs/draw.md` (the feature doc) if we ship.

---

## 1. What Draw is

A new workspace type alongside Pages and Tables: one Excalidraw scene per
item, at `/draw`. Sketch architecture, plan visually, whiteboard an idea, and
have the drawing land in the brain like every other content type: summarized,
embedded, chunked, searchable, citable.

Built on the **npm package `@excalidraw/excalidraw`** (MIT, React component,
peer-dep React 19, actively released). We do NOT vendor or fork the
excalidraw repo. The clone at `~/Projects/excalidraw` is a reading reference
only.

Why not fork (verified 2026-08-07 by a build spike in this worktree):

- The package installs and builds cleanly against jackdaw (Next 16 +
  Turbopack + React 19.2.7): `tsc --noEmit` clean, `next build` clean.
- The editor lands as a **lazy route chunk (~1.8 MB JS + 139 KB CSS)**
  referenced only by the draw route's client manifest. No other route pays
  for it.
- Upstream ships `restore()` / `restoreElements()`, a scene-format migration
  function. Old stored scenes are upgraded on load by upstream code, so
  "merge latest updates" is `pnpm up @excalidraw/excalidraw`, not a rebase.
- A fork means hand-merging a high-velocity upstream forever. That is the
  instability we are explicitly avoiding.

Pin the dependency **exact** (`0.18.1`, no caret), same discipline as
`mermaid`. Upgrades are deliberate, tested against stored scenes.

## 2. Design constraints (inherited from Pages)

- **One scene per draw node.** A `nodes` row + a 1:1 sidecar. No multi-board
  files, no infinite workspace of workspaces.
- **No real-time collaboration, ever.** Excalidraw's collab module is simply
  never mounted. Single-user, self-hosted; the storage substrate stays a
  plain JSON blob.
- **Draft / commit, exactly like Pages.** The canvas fires `onChange`
  continuously; autosave writes a private draft, only an explicit Commit
  publishes + indexes. One extractor run per session, not hundreds.
- **The brain's architecture does not change.** Draw registers through the
  same seams every type uses (enum value, extractor allowlist,
  `readNodeBodyRaw` branch, search enums). A new room on existing wiring.
- **Human-legible source.** The scene is JSON, not markdown, so the Pages
  dialect principle does not apply 1:1. The legibility guarantee is instead:
  `scene_text` (derived) is always readable, and agent authoring (Phase 6)
  goes through the documented Skeleton JSON dialect, never raw internals.

## 3. Data model

```
nodes (type='draw')                      ltree root: 'draw'
  title / slug / path / tags             standard node fields
  data.summary, data.entities            written by the extractor
  embedding                              summary embedding

draws (sidecar, packages/db/src/schema/draws.ts)  1:1, mirrors pages
  node_id     uuid PK, FK nodes ON DELETE CASCADE
  scene       jsonb    { elements, appState? } COMMITTED scene (source of truth)
  scene_text  text     derived plaintext (extractor + FTS read this)
  scene_svg   text     SVG export captured client-side AT COMMIT (see §5)
  draft_scene jsonb    autosaved working copy, NULL when nothing uncommitted
  draft_updated_at timestamptz
  draft_rev   int      optimistic-concurrency etag (mirror of pages.draft_rev)
  version     int
  created_at / updated_at
```

Decisions:

- **`appState` is stored trimmed.** Persist only the durable subset
  (`viewBackgroundColor`, `gridSize`, scroll/zoom for resume). Never persist
  collaborator/session state. Whitelist, don't blacklist.
- **`files` (pasted images) do NOT live in the scene blob.** Excalidraw's
  `BinaryFiles` are dataURLs; a few screenshots would balloon the jsonb row.
  Each binary file becomes a real `file` node via the existing files
  pipeline (upload on add, same as the page editor's image upload), and the
  sidecar stores a `file_refs jsonb` map `{ excalidrawFileId -> nodeId }`.
  On load, the editor rehydrates `BinaryFiles` by fetching `?raw=1`. This
  also means embedded images get OCR'd once by the files pipeline, and (like
  Pages `foldEmbeddedText`) their extracted text can fold into `scene_text`
  on commit. Phase 2 ships without image support if this drags; images are
  a fast-follow inside the phase, not a blocker.
- **`scene_text` is computed server-side by our own walker**, not by the
  excalidraw package (which is browser-oriented). Upstream's
  `getTextFromElements` is a 12-line reduce over `element.text`; ours
  (`packages/content/src/scene-to-text.ts`) does better while staying tiny:
  frame names as `#` headings with their member elements grouped under them,
  free text and sticky notes as lines, arrow/container labels inline,
  connected `A -> B` pairs rendered as relations when both ends have labels.
  Pure function + tests, no excalidraw import.

## 4. Migrations

Two files, honoring the migrate.ts rule (an enum value cannot be added and
used in the same transaction):

- `0144_node_type_draw.sql`: `ALTER TYPE node_type ADD VALUE 'draw';`
- `0145_draws.sql`: the sidecar table above + indexes.

Feature branches never touch version fields; the bump happens on main at
merge time via `scripts/merge-branch.sh`, if we merge at all.

## 5. Rendering surfaces (why `scene_svg` exists)

The committed SVG snapshot is captured **client-side at commit** using the
package's `exportToSvg` (the editor already has the scene in memory), sent in
the commit payload, sanitized server-side, and stored in the sidecar.

That one column gives every non-editor surface a cheap, deterministic render
with zero server-side Excalidraw execution:

| Surface | Renders |
|---|---|
| `/draw` list preview | `scene_svg` inline (scaled) |
| Read-only view + `/s/[token]` share | `scene_svg` |
| Email / docx export | `scene_svg` (docx embeds it as an image via the existing loader) |
| PDF export | `scene_svg` through the existing print sidecar |

No browserless/chromium involvement, no excalidraw-in-Node. The SVG is
regenerated on every commit so it can never drift from `scene`.

Sanitization: run the committed SVG through the same server-side SVG
sanitizer path the sharing renderer uses (strip scripts/foreignObject event
handlers) before storing. The SVG references self-hosted fonts (§7).

## 6. Phases

### Phase 0: foundation (small)
- `pnpm -C jackdaw add @excalidraw/excalidraw@0.18.1` (exact pin).
- Self-host assets: copy `dist/prod/fonts` into `jackdaw/public/
  excalidraw-assets/` (build script step, not a checked-in blob dump if the
  size is obnoxious; decide when we see it), set
  `window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'` before mount.
  Mandatory: self-hosted instances must not fetch fonts from a CDN.
- `<ExcalidrawCanvas>` client component: `next/dynamic` `ssr:false`, theme
  wired to next-themes, `viewModeEnabled` prop for read-only.
- Gate: canvas mounts on a dev route, draws, undo/redo, dark/light, offline
  (no CDN fetches in the network log).

### Phase 1: data model + CRUD
- Migrations 0144 + 0145; `packages/db/src/schema/draws.ts`.
- `packages/content/src/draws.ts` mirroring `pages.ts`: `listDraws`,
  `getDraw`, `createDraw`, `saveDraft` (draft_rev optimistic concurrency,
  reuse `evaluateDraftRev`), `commitDraw` (promote draft, recompute
  `scene_text`, store sanitized `scene_svg`, bump version, fire
  `node_ingested`), `discardDraft`, `deleteDraw`.
- `packages/content/src/scene-to-text.ts` + tests (the walker from §3).
- API routes under `server/web/app/api/draws/`: list/create, get/patch/
  delete, `[id]/draft` (PUT), `[id]/commit` (POST). Clone the pages routes.
- Gate: unit tests for scene-to-text + draft/commit round-trip; a scene
  survives store -> load -> `restore()` -> re-store byte-stable modulo
  restore's own normalization.

### Phase 2: editor UI
- `/draw` master-detail list (clone the pages shell) + `/draw/[id]` editor.
- Autosave: debounce `onChange` ~1.5 s (8 s max), flush on blur/leave, into
  the draft; status chip Saving -> Draft·uncommitted -> Committed; Commit
  button + ⌘S. All patterns lifted from the page editor.
  `onChange` fires on selection/viewport changes too; hash the elements
  array (`hashElementsVersion` export) and skip no-op saves.
- Editor loads `draft_scene ?? scene` through `restore()` every time.
- Image support: paste/drop -> upload via files pipeline -> `file_refs`
  (see §3).
- Nav: `nav-items.ts` entry (icon: PenTool or similar) + `help-topics.ts`.
- Gate: full draw/save/leave/resume/commit loop on the dev box; a reload
  mid-draft loses nothing.

### Phase 3: brain wiring
- `'draw'` into the extractor's `DEFAULT_EXTRACT_TYPES`
  (server/api/src/agent/extractor.ts) + `readNodeBodyRaw` branch returning
  `draws.scene_text`.
- `'draw'` into the search enums: `packages/tools/src/builtins.ts`,
  `packages/mcp-core/src/build-server.ts`, and the search palette icon map
  (`jackdaw/components/search/node-type-icons.ts`; keyed off the enum so
  the compiler catches the omission).
- Chunks come free (`chunkDocText` over `scene_text`); frame headings give
  section context.
- Optional, cheap: fold referenced files' extracted `data.text` into
  `scene_text` on commit (Pages' `foldEmbeddedText`, same bounds).
- Gate: commit a labeled architecture sketch, then find it via `search` and
  `search_chunks` by a term that appears only inside the drawing.

### Phase 4: sharing + export
- `'draw'` into `SHAREABLE_TYPES` (packages/content/src/shares.ts) and the
  `/s/[token]` renderer: serve `scene_svg` in the shared page shell.
- Export menu: SVG + PNG download (client-side `exportToBlob`); PDF via the
  existing print sidecar rendering `scene_svg`.
- Gate: a share link renders the drawing with no JS beyond the page shell.

### Phase 5: agents read (cheap, do with 3 or 4)
- `draw_list` / `draw_get` builtins (`packages/tools/src/builtins-draws.ts`):
  `draw_get` returns metadata + `scene_text`. Saskia can find and read
  drawings. MCP stays read-only, same posture as Pages.

### Phase 6: agents write (deferred; separate decision)
- The honest option, matching the Pages "agent writes the markdown dialect"
  principle: agent tools accept **Excalidraw Skeleton JSON** (the documented
  simplified format) or a Mermaid fence. Conversion
  (`convertToExcalidrawElements`, `mermaid-to-excalidraw`) runs client-side
  or in the browser sidecar, because those libraries are browser-oriented.
  That extra moving part is why this phase is deferred and re-scoped on its
  own merits after 0-5 prove out. Not part of the go/no-go.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Upstream scene-format drift breaks stored scenes | `restore()` on every load; exact-pinned version; upgrade = deliberate PR that loads a corpus of stored scenes in dev first |
| Bundle bloat leaks beyond the draw route | Verified isolated in the spike; add a size check to the Phase 2 gate (no other route's first-load JS moves) |
| Image-heavy scenes balloon jsonb rows | Binary files live in the files pipeline, never in the scene blob (§3) |
| `onChange` autosave storm | Debounce + `hashElementsVersion` no-op skip + draft/commit split |
| Fonts fetched from CDN on self-hosted boxes | Self-hosted assets in Phase 0, gated by an offline test |
| Docker image growth (~47 MB unpacked package) | Accepted; only `dist/prod` is served. Note it in the release notes if we ship |
| Draft written by two devices | `draft_rev` etag, same conflict semantics as Pages/Tables |

## 8. Go / no-go

Re-evaluate after Phase 3 (the earliest point where the full loop exists:
draw -> commit -> indexed -> searchable). Ship-blockers, any one of which
kills the merge:

1. Any change to existing tables, existing routes' behaviour, or shared
   chunks' size. The diff must be purely additive outside `package.json`.
2. Editor jank that Pages doesn't have (input latency, lost drafts).
3. Scene corruption across an upstream upgrade exercised in dev.
4. The extractor producing garbage summaries from `scene_text` (would mean
   the walker needs rework, not necessarily a kill, but a stop-and-rethink).

If killed: revert is `git branch -D feat/draw-workspace` + drop the two
migrations from dev DBs (`DROP TABLE draws; -- enum value stays, harmless`).
Nothing on main ever knew.
