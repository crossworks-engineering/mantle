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
| **Highlight + text colour** | extended `Highlight` mark + a custom `textColor` mark | bubble-menu swatch popovers; themed-token palette (`chart-1..5`, stored as a token key, never a raw colour); rendered in editor + public; authored by Saskia via `[text]{color=…}` / `{highlight=…}` (see [`rich-writing.md`](./rich-writing.md)) |
| To-do lists | `@tiptap/extension-task-list/-item` | slash item, themed CSS, `[x]`/`[ ]` in `docToText` |
| Tables | `@tiptap/extension-table` (`TableKit`) | the `+` add row/column controls, themed CSS |
| Drag handle | `@tiptap/extension-drag-handle-react` | grip + click-menu (Duplicate/Delete) |
| Slash menu, @-mentions | `@tiptap/suggestion` | the popups + commands |
| Callout, columns | — | custom schema nodes + CSS |
| Code highlighting | `@tiptap/extension-code-block-lowlight` + `lowlight` | `.hljs-*` mapped to theme tokens (CSS) |
| Math | `@tiptap/extension-mathematics` + `katex` | `$…$` / `$$…$$`; `latex` surfaced in `docToText` |
| Image / file embeds | — | custom `image` + `fileEmbed` nodes; upload via the files pipeline; slash + drag/paste |

**Agent authoring:** an agent can now create/update pages too — `markdownToDoc`
([`packages/content/src/markdown-to-doc.ts`](../packages/content/src/markdown-to-doc.ts))
converts a rich-markdown dialect into this schema's JSON, and the `page_*` tools
wrap the CRUD. See [`rich-writing.md`](./rich-writing.md).

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
  (passage-level vector search across all content).
- **In-app agent (read + write):** the web assistant's builtins include
  `page_create` / `page_update` / `page_delete` / `page_list` / `page_get`
  ([`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts)).
  Authoring goes through `markdownToDoc` (the LLM writes the rich-markdown
  dialect, not raw ProseMirror JSON) — see [`rich-writing.md`](./rich-writing.md).
  *(The MCP surface above is still read-only; only the in-app agent authors.)*
- **Public sharing:** a page can be shared read-only at `/s/[token]` — see
  [`sharing.md`](./sharing.md).

---

## 8. Known sharp edges / deferred

- **Editor reliability + polish (2026-05-24/25).** A pass over the worst jank:
  the block **drag handle** is centred on its row and lives in the editor's left
  padding so it no longer vanishes before you can grab it; the **slash / @-mention
  popups** reposition via a `ResizeObserver` + viewport clamp (no more first-open
  jump) and no longer close when the autosave fires (the autosave re-render was
  re-applying `editor.setOptions` + re-registering the drag-handle plugin —
  memoizing `editorProps` + the `<DragHandle>` props fixed it). The **divider**
  is a soft fade and **tables** get themed rounded corners. NOTE: an earlier
  finishing-batch (sub/superscript, text-align, audio, emoji, YouTube,
  details/toggle, full table ops) was built then **fully reverted** — only the
  colours + the reliability/polish above survived. Don't re-pitch the reverted
  set without solving their specific issues (see the project memory).
- **Backlinks are written but not surfaced.** `references` edges exist in the
  graph (queryable by Saskia/MCP), but there's no "Linked from / Referenced by"
  panel on a page yet, and node-link chips don't yet click-through to navigate.
  Both are UI follow-ups on top of the edges that now exist.
- **Responder/assistant don't use `searchChunks` yet.** Chunk retrieval is
  available via MCP; wiring it into the live context assembly touches the
  responder and was deliberately left for an explicit go-ahead.
- **Public sharing** — ✅ built (generalised to all content types). Revocable
  share tokens, a public `/s/[token]` route, a server-side sanitized
  JSON→HTML renderer, and scoped serving of embedded private assets. See
  [`sharing.md`](./sharing.md).
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
- **Pages agent** — ✅ built (Phase 2a). Slug `pages`, role `custom`,
  model `anthropic/claude-sonnet-4.6`. Granted page tools (sans
  `page_update` and `page_delete`) + file + search tools. Writes to
  `draft_doc` only via `page_update_draft` — the live page is
  structurally protected. Saskia delegates page-edits to it via
  `invoke_agent({ agent_slug: 'pages', … })`. Seed: `pnpm seed:pages`.
- **Block ids on every block-level node** — ✅ built (Phase 2b
  foundation). Every paragraph / heading / callout / column / list
  item / table cell / etc. carries an `attrs.id` (UUID, ~36 chars)
  that survives the editor's parse / serialize / save round-trip via
  the `BlockId` global-attribute extension. Source of truth:
  `@mantle/content`'s `ensureBlockIds` runs server-side on
  `markdownToDoc`, `getPage` (lazy backfill — legacy docs get ids on
  read, persisted on next saveDraft / commit), `saveDraft`,
  `commitPage`. The editor's `BlockId` TipTap extension preserves the
  attr on every block type so user edits don't strip ids placed by
  the agent.
- **`page_blocks_list` tool** — ✅ built (Phase 2b foundation).
  Lightweight TOC view: `[{ id, kind, depth, preview, meta? }]` per
  block, body NOT returned. Powers the agent's "what's in this page?"
  lookup. Agent reads the TOC, decides which blocks to touch (Phase
  2b mutation tools land next), then fetches only those.
- **Block-addressed editing + editor AI-assist panel** — designed,
  not built. The agent operates on **block-addressed edits** (high-
  level ops the LLM emits reliably), the server compiles those to
  ProseMirror `Step`s (typed, atomic, invertible — free undo +
  history), and the editor shows the proposed changes as a **per-
  block visual diff** before the user commits:
  - removed content rendered with a **red background / strike-through**
  - new content rendered with a **green border / highlight**
  - per-block Accept / Discard controls (no all-or-nothing commit)
  - edits land in `draft_doc`; only Accept promotes to `doc` and fires
    `node_ingested` (re-extract). Nothing damages the saved page until
    the operator opts in.
  - sweeping requests ("restyle the whole page") fall back to
    section-by-section processing with a progress UI ("editing 4 of
    12…") so the model never has to re-emit the full body. Output
    bytes scale with **changes**, not document size — the lever that
    Notion's "style this page" feature lacks.

  See [architecture.md §9g](./architecture.md#9g-web-assistant--full-multimedia-parity-with-telegram)
  for the surrounding /assistant context.

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
