# Pages — Notion-style documents

> A rich-document content type: callouts, columns, tables, to-do lists,
> highlights, @-mentions — authored in a TipTap editor, stored as one
> document per page, and wired into the brain like every other content type.
>
> Companion docs: [`architecture.md`](./architecture.md) (the `nodes`
> abstraction + extractor), [`memory.md`](./memory.md) (the six memory layers
> + `content_chunks`), [`content.md`](./content.md) (the lighter notes / todos
> / events surfaces).

---

## 1. What pages are (and aren't)

Pages are Mantle's answer to Notion **pages** — *not* Notion databases. The
goal is "present, share, plan": long-form, structured, visually rich
documents. Three deliberate constraints:

- **One document per page.** Not block-per-row like Notion. A page is a single
  ProseMirror/TipTap JSON document in a sidecar table. Single-user, self-hosted
  — none of the per-block fan-out Notion needs for multiplayer applies here.
- **No real-time collaboration, ever.** Federation between Mantle instances
  happens system-to-system over MCP, never live co-editing. So the storage
  substrate stays a plain JSON blob (no CRDT/Yjs).
- **The editor is invisible.** No chrome, no fixed toolbar. A faint title, a
  blank canvas, and formatting that appears only when you reach for it
  (markdown shortcuts, the `/` slash menu, the selection bubble menu).

---

## 2. Data model

A page is a `nodes` row of `type='page'` plus a 1:1 `pages` sidecar holding the
document. Heavy/large data lives in the sidecar so tree and index scans over
`nodes` stay lean — the same split used by `emails` and `secrets`.

```
nodes (type='page')
  title                 display name
  slug / path / tags    standard node fields ('pages' ltree root)
  data.icon             emoji/icon (optional)
  data.width            'narrow' | 'wide'  (Notion-style page width)
  data.visibility       'private' | 'public'  (read-only sharing, Phase 5)
  data.summary          ← written by the extractor
  data.entities         ← written by the extractor
  embedding             ← summary embedding (the content_index "spine")

pages (sidecar, packages/db/src/schema/pages.ts)
  node_id (PK, FK→nodes ON DELETE CASCADE)
  doc        jsonb   ProseMirror JSON — the PUBLISHED document (source of truth)
  doc_text   text    derived plaintext (what the extractor + FTS read)
  draft_doc  jsonb   autosaved working copy, NULL when nothing uncommitted
  draft_updated_at
  version    int
```

`doc` is the canonical ProseMirror JSON — *not* markdown. Markdown is lossy for
callouts/columns/mentions, so JSON is the source of truth and `doc_text`
(via `docToText`) is the derived plaintext the brain consumes.

CRUD lives in [`packages/content/src/pages.ts`](../packages/content/src/pages.ts),
mirroring `notes.ts`. Migrations: `0037` (enum value), `0038` (sidecar), `0039`
(draft columns).

---

## 3. The draft / commit model

The single most important behavioural decision. **Autosave is a private draft;
only an explicit Commit publishes and indexes.**

| | Autosave (draft) | Commit |
|---|---|---|
| Writes | `pages.draft_doc` only | promotes `draft_doc` → `doc`, recomputes `doc_text`, clears the draft, bumps `version` |
| Rendered elsewhere? | **No** — list preview, read-only view, MCP all read the published `doc` | Yes |
| Indexed (extractor)? | **Never** | Yes — fires `node_ingested` |
| When | ~1.5s after a pause (8s max), flushed on blur/leave | Commit button, or ⌘/Ctrl+S — enabled only when there are uncommitted changes |

Why: the extractor (LLM summary + embedding + facts + entities) is expensive
and was being re-run on every editing pause. Drafts make typing cheap and
durable; commits make indexing deliberate. A 30-minute editing session is now
**one** extractor run, not dozens.

- Code: `saveDraft()` / `commitPage()` in `packages/content/src/pages.ts`.
- API: `PUT /api/pages/[id]/draft`, `POST /api/pages/[id]/commit`.
- The editor loads `draft ?? doc`, so you resume unsaved work; status shows
  Saving → Draft·uncommitted → Committed.
- Title/tags/width save *live* (cheap metadata; never index).

---

## 4. The editor

TipTap (which is ProseMirror) does the heavy lifting; we wrote the glue. The
strategy throughout: **reuse libraries, write only what they don't provide.**

| Capability | Library | What we wrote |
|---|---|---|
| Core, marks, lists, headings, history, **link, underline** | `@tiptap/starter-kit` | Link tuned (autolink/paste); link dialog |
| Highlight, typography | `@tiptap/extension-highlight`, `-typography` | bubble-menu wiring + themed CSS |
| To-do lists | `@tiptap/extension-task-list/-item` | slash item, themed CSS, `[x]`/`[ ]` in `docToText` |
| Tables | `@tiptap/extension-table` (`TableKit`) | the `+` add row/column controls, themed CSS |
| Drag handle | `@tiptap/extension-drag-handle-react` | grip + click-menu (Duplicate/Delete) |
| Slash menu, @-mentions | `@tiptap/suggestion` | the popups + commands |
| Callout, columns | — | custom schema nodes + CSS |

Components live in [`apps/web/components/page-editor/`](../apps/web/components/page-editor/):

- `extensions.ts` — the shared schema (used by both the live editor and the
  read-only renderer, so they render identically).
- `page-editor.tsx` — the editable surface (no chrome). `page-view.tsx` —
  read-only render (list preview).
- `bubble-menu.tsx` — selection toolbar (bold/italic/highlight/link/headings/…).
- `slash-command.ts` + `slash-menu.tsx` — `/` block picker.
- `drag-handle.tsx` — the gutter grip; **drag and click-menu are one element**
  via a native `onClick` (a Radix trigger preventDefaults pointerdown and kills
  the native dragstart — that was the "grab cursor but won't move" bug).
- `table-controls.tsx` — floating `+` buttons positioned off the live table
  rect (the TipTap DragHandle only positions the *left* gutter).
- `callout.ts`/`callout-view.tsx`, `column.ts`, `mention.ts`/`mention-list.tsx`.

Editor route: [`apps/web/app/(app)/pages/[id]`](../apps/web/app/(app)/pages);
list (master-detail) at `/pages`. The page body uses base `prose` (16px).

### Custom-node pattern
`Node.create()` + `ReactNodeViewRenderer` (for interactive nodes like callout)
→ add to the **shared** `pageExtensions` → add a slash item → ensure
`docToText` walks it (see `BLOCK_TYPES`). Columns/tables are pure layout, so
they're schema + CSS with no NodeView.

---

## 5. How pages plug into the brain

**The brain's architecture was not changed.** Pages use the standard
"register a new content type" seam every type uses:

- `page` is in the extractor's `DEFAULT_EXTRACT_TYPES`
  ([`apps/agent/src/extractor.ts`](../apps/agent/src/extractor.ts)).
- `readNodeBodyRaw` has a `page` branch that returns `pages.doc_text`.
- `docToText` ([`packages/content/src/doc-to-text.ts`](../packages/content/src/doc-to-text.ts))
  flattens the ProseMirror JSON to plaintext (headings as `#`, to-do state as
  `[x]`/`[ ]`, mention/atom labels surfaced, callout/column/table content
  walked).

So on commit a page flows through the *existing* pipeline — summary, embedding,
facts, entity reconciliation — exactly like a note. Saskia can find pages,
they contribute facts and `mentioned_in` edges, all via code that was already
there. **Pages are a new room wired into the existing electrical, not new
wiring.**

### @-mentions / links → graph edges (non-invasive)
`@` opens one picker over the owner's **existing** references, read-only via
`GET /api/mentions/search` (grouped: *Pages & notes* first, then *People &
things*). Each chip carries `{ id, label, ref, kind }`:

- **`ref:'node'`** — a page/note. (Notes are markdown so they can't *author*
  mentions, but they're valid *targets*.)
- **`ref:'entity'`** — a person/project/place. ("Person" is an `entities` row,
  never `auth.users`.)

Edges are built **by id**, in the extractor's `reconcile_entities` step, after
its NER pass — `mentionRefs` (`@mantle/content`) splits the doc's chips into
entity ids and node ids:

- entity refs → `entity --mentioned_in--> page` (guaranteed regardless of NER
  recall; deduped against the NER pass);
- node refs → `node --references--> node` (backlinks); self-refs and deleted
  targets skipped.

Both are tagged `data.explicit:true` and fully idempotent: the step clears the
node's inbound `mentioned_in` *and* its outbound `references` before rebuilding
(Phase-4b rule), so re-commits never duplicate. Single edge writer (the
extractor) — no commit-path edge code. The mention name also lands in
`doc_text`, so NER still contributes edges for *un-chipped* names typed as
plain text.

### Chunked retrieval (`content_chunks`, Phase 4)
A long document squeezed into one embedding searches poorly. The extractor now
also writes **per-section chunks**:

- `chunkDocText()` ([`packages/content/src/chunk.ts`](../packages/content/src/chunk.ts))
  greedy-packs lines to ~1500 chars, tracking the current heading as section
  context; long docs → many chunks, short docs → one.
- The extractor's `write_chunks` step **deletes the node's chunks then
  re-inserts** (idempotent — re-extract replaces, never accumulates), embedding
  each chunk.
- `searchChunks()` ([`packages/search/src/chunks.ts`](../packages/search/src/chunks.ts))
  does cosine search over `content_chunks`, joined to the node. Exposed via the
  MCP `search_chunks` tool. (Migration `0040`.)

This is generalised, not pages-specific — long emails/files benefit too.

---

## 6. What happens on edit + re-save (re-extract semantics)

A frequently-asked question; verified against the extractor. When a node is
re-indexed, derived brain data is **rebuilt, not duplicated**:

| Artifact | On re-extract |
|---|---|
| `data.summary` + `embedding` | overwritten in place |
| Entities | `reconcileEntity` reuses by name (no duplicate rows) |
| Facts | vector-dedup + ADD/UPDATE/DELETE/**NOOP** classifier (an LLM call per candidate when a near-match exists) |
| `content_chunks` | delete-for-node, then re-insert (idempotent) |
| `mentioned_in` edges (inbound) | **cleared for the node, then re-inserted** (idempotent) |
| `references` edges (outbound page→node links) | **cleared for the node, then re-inserted** (idempotent) |

The last row was a fix landed in Phase 4 — previously the extractor *appended*
`mentioned_in` edges on every run, so re-extracts accumulated duplicates. Both
new derived artifacts (chunks, edges) follow the same **delete-then-rebuild
per node** rule.

**Re-extract is not free** — each runs the summary LLM and the fact classifier.
This is exactly why pages use draft/commit (re-extract only on deliberate
commit), and why short content's re-extract cost is bounded by the embedding
cache + `extract_cost_cap_micro_usd`.

---

## 7. Surfaces

- **Web API:** `/api/pages` (list/create), `/api/pages/[id]` (get/patch/delete),
  `/api/pages/[id]/draft` (PUT), `/api/pages/[id]/commit` (POST),
  `/api/mentions/search` (mention/link autocomplete — pages, notes, entities;
  read-only).
- **MCP (read-only for pages):** `page_list`, `page_get`, plus `search_chunks`
  (passage-level vector search across all content). Authoring stays in the
  editor — the LLM doesn't generate ProseMirror JSON.

---

## 8. Known sharp edges / deferred

- **Backlinks are written but not surfaced.** `references` edges exist in the
  graph (queryable by Saskia/MCP), but there's no "Linked from / Referenced by"
  panel on a page yet, and node-link chips don't yet click-through to navigate.
  Both are UI follow-ups on top of the edges that now exist.
- **Responder/assistant don't use `searchChunks` yet.** Chunk retrieval is
  available via MCP; wiring it into the live context assembly touches the
  responder and was deliberately left for an explicit go-ahead.
- **Public sharing (Phase 5)** — not built. Needs a `visibility`/share-token,
  a public route outside the auth gate, a sanitized JSON→HTML renderer, and
  public-scoping of embedded private file/image assets.
- **Tables:** whole-table delete via the block handle; per-row/column delete
  not yet wired. `+` adds relative to the current cell.
- **Columns:** fixed 2/3/4 via the slash menu — no drag-to-create or resize
  (the genuinely hard 80% of Notion columns), by design.
- **Image/file embeds** — ✅ built. `image` + `fileEmbed` nodes
  (`components/page-editor/image.ts`, `file-embed.ts`) reference a backing
  `file` node by id (upload via `POST /api/files/files`, serve via `?raw=1`).
  Insert via the slash menu or drag-and-drop / paste (`upload.ts` +
  `page-editor.tsx` handleDrop/handlePaste). Images also parse from markdown
  `![](…)`, so Saskia can embed by URL.
- **Formulas** — ✅ built. KaTeX via `@tiptap/extension-mathematics`
  (`inlineMath` `$…$`, `blockMath` `$$…$$`); stylesheet imported in
  `app/layout.tsx`; `latex` source flows into `docToText` for indexing.

---

## 9. Reading the code

1. `packages/db/src/schema/pages.ts` + `content-chunks.ts` — the storage.
2. `packages/content/src/pages.ts` — CRUD + draft/commit.
3. `packages/content/src/doc-to-text.ts` + `chunk.ts` — the brain serializers.
4. `apps/web/components/page-editor/extensions.ts` — the editor schema; follow
   imports for each feature.
5. `apps/web/app/(app)/pages/[id]/page-detail-client.tsx` — the autosave/commit
   state machine.
6. `apps/agent/src/extractor.ts` `write_chunks` + `reconcile_entities` steps —
   how a page reaches the brain.
