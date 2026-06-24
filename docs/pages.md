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
- **Embedded assets are folded into the index.** A page references its images
  and file chips by `nodeId` (they're real `file` nodes from the files
  pipeline, so each is vision/OCR'd or parsed once on its own ingest). On
  **commit**, `commitPage()` appends those referenced files' extracted
  `data.text` to the page's `doc_text` (`foldEmbeddedText`, bounded
  4 KB/file · 16 KB total, doc order preserved). So the page is searchable by —
  and its summary reflects — what's *inside* its images/docs, not just their
  filenames. A referenced file whose own extraction hasn't landed yet is
  skipped and picked up on the next commit (no reactive re-extract).

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
| Aside | — | custom `aside` node + NodeView; themed gradient (selected `chart-N` + angle) painted from one shared helper (`aside-style.ts`) so editor/public/email match; ✨ swatch reshuffles |
| Code highlighting | `@tiptap/extension-code-block-lowlight` + `lowlight` | `.hljs-*` mapped to theme tokens (CSS) |
| Math | `@tiptap/extension-mathematics` + `katex` | `$…$` / `$$…$$`; `latex` surfaced in `docToText` |
| Image / file embeds | — | custom `image` + `fileEmbed` nodes; upload via the files pipeline; slash + drag/paste |

**Agent authoring:** an agent can now create/update pages too — `markdownToDoc`
([`packages/content/src/markdown-to-doc.ts`](../packages/content/src/markdown-to-doc.ts))
converts a rich-markdown dialect into this schema's JSON, and the `page_*` tools
wrap the CRUD. See [`rich-writing.md`](./rich-writing.md). `markdownToDoc` also
imports Notion's `<aside>…</aside>` callout export as real aside blocks
(colour/angle cycled for variety).

**Paste-to-convert:** pasting a markdown document straight into the editor
converts it to real blocks (callouts, asides, columns, tables, headings, …) via
the same `markdownToDoc` — so a Notion "Copy as Markdown" lands as a perfect
page, not literal `#`/`<aside>` text. `PageEditor`'s `handlePaste` only does this
for a **plain-text** paste (a rich copy carries `text/html`, left to TipTap's own
parser) that's **multi-line with strong block-markdown signals** (heading,
`<aside>`, `:::` fence, code fence, table, image, task list); ordinary text paste
is untouched. One ⌘Z reverts to raw text.

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
- `callout.ts`/`callout-view.tsx`, `aside.ts`/`aside-view.tsx`/`aside-style.ts`
  (the gradient cousin of callout), `column.ts`, `mention.ts`/`mention-list.tsx`.

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
  `page_create` (pass `parent_id` to nest a **sub-page**) / `page_update` / `page_delete` / `page_list` / `page_get`
  ([`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts)),
  block-addressed edits (`page_block_*`), and `page_split` (break a long page
  into sub-pages along its headings — see §8 Phase 4b).
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
- **Backlinks panel + node-chip navigation** — ✅ **built.** `listBacklinks`
  (pages.ts) resolves inbound `references` edges; `<PageBacklinks>` renders a
  "Referenced by" section at the foot of the page; node-link `@`-mention chips
  navigate on click (`nodeHref` + the editor's `handleClick`). See the
  backlinks commit.
- **Responder/assistant chunk retrieval** — ✅ **built + eval-covered** (commit
  `9afbcd0`, "auto-chunk retrieval"). `loadConversationContext`
  ([`packages/agent-runtime/src/conversation.ts`](../packages/agent-runtime/src/conversation.ts))
  calls `searchChunks` (default `chunk_limit=3`, 0.65 cosine cutoff, salience-
  aware, system-docs + telegram excluded) and injects the passages as the
  prompt's "Relevant passages" block — on **every** surface (web assistant +
  Telegram responder share this path). The recall eval's `prod` row counts
  `chunkHits` and a dedicated `chunks` retriever measures it
  ([`docs/recall-eval.md`](./recall-eval.md)).
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
- **Block-addressed editing tools** — ✅ built (Phase 2b). `page_block_get`,
  `page_block_update`, `page_block_insert_after`, `page_block_delete`. All
  write to `draft_doc`; first new block on `update` inherits the target's
  id (agent continuity); delete refuses to leave a container empty.
- **AI-assist side panel** — ✅ built (Phase 3a Pass 1). Side panel in the
  page editor, chat input, per-reply diff summary card (counts + collapsible
  per-change preview with red strike-through / green highlight), discard-
  draft button. Editor remounts on AI changes via prop-keyed effect.
  `/api/pages/[id]/ai-assist` invokes Pages via `invokeAgent`; Pages writes
  to `draft_doc`; user reviews + commits via the existing toolbar.
- **Editor visual diff (Phase 3a Pass 2)** — ✅ **built.** A "Review" mode in
  the editor paints exactly what Commit will publish vs the live page:
  - `computeDiffOverlay` ([`page-diff.ts`](../packages/content/src/page-diff.ts))
    turns (committed `doc`, draft) into the sets to paint — added (top-most),
    changed (deepest, so a changed inner block borders, not its shell), and
    TOP-LEVEL removed blocks with the text + anchor to ghost them. Pure +
    tested; recomputed client-side on every draft change so it always matches
    "what Commit will publish".
  - `DiffReview` ([`diff-review.ts`](../apps/web/components/page-editor/diff-review.ts))
    is the editor overlay (same meta-driven decoration pattern as `focus-marks`):
    node borders for added (green/chart-4) + changed (amber/chart-5), and
    **widget "ghost" cards** for removed blocks (red, struck-through) rendered
    where they used to be — the only way to show a deletion, since removed
    content isn't in the draft. Never mutates the doc.
  - **Per-block Discard / Restore**: each added/changed block gets a hover
    "Discard" pill; each ghost a "Restore" button. They dispatch a bubbling
    `mantle:diff-action` event; `page-detail-client` does the surgery (revert a
    changed block to committed, delete an added block, re-insert a removed one)
    on the live doc, which autosaves + recomputes the overlay. Commit = accept
    all; the AI panel's Revert = reject all.
  - Toolbar **Review** toggle (auto-on after an AI run) with a change count;
    the ‹ › nav cycles the added/changed blocks.

  See [architecture.md §9g](./architecture.md#9g-web-assistant--full-multimedia-parity-with-telegram)
  for the surrounding /assistant context.

- **Gutter focus marker** — ✅ **built (2026-05-28).** A left-gutter
  "highlighter" for marking *many* sections of a page, then handing exactly
  those blocks to Pages — the scalable answer to "rephrase these bits, leave
  the rest alone". Deliberately NOT a pen-over-text highlighter (that fights
  ProseMirror's selection model and spans partial blocks); the gutter maps
  cleanly onto the Phase 2b stable block ids.
  - `focus-marks.ts` — editor-only extension; highlights a SET of blocks by
    `attrs.id` via ProseMirror node decorations (left accent bar + tint).
    Driven by a meta transaction, so it never mutates the doc (and
    `PageEditor.onUpdate` now guards on `transaction.docChanged`, so a
    meta-only mark push can't trip autosave). Same decoration primitive the
    Phase 3a Pass 2 visual diff will reuse.
  - `focus-gutter.tsx` — a strip over the editor's 2.5rem left padding,
    shown only in marker mode (the drag handle steps aside). Drag → mark a
    contiguous run (added to the set; repeat for multiple ranges); click a row
    → toggle. Resolves blocks off `data-block-id` in the rendered DOM, hit-test
    by vertical rect (x/scroll-independent); id-less unsaved blocks skipped.
  - State lives in `page-detail-client` ("Mark" toolbar toggle + count + Clear),
    persisted per page in `localStorage` (survives reload + the AI-change
    editor remount); never serialized into the document.
  - Hand-off: the AI-assist panel shows "Focusing N marked sections" and sends
    `focusBlockIds`; `/api/pages/[id]/ai-assist` injects a FOCUS directive
    (`lib/focus-directive.ts`) telling Pages to operate ONLY on those ids and
    leave the rest byte-for-byte. **No new agent tools** — Pages already edits
    by block id; the marker just names the targets.
  - Deferred (next slice): **gutter break → child page** — a between-blocks
    "break here" / "extract marked range → sub-page" that creates a child from
    the selected blocks and drops a `childPage` card in their place (Phase 4c
    realized through the gutter, landing on the 4a foundation).

- **Block-editor safety skill (architectural note, not slated)** — Pages's
  HARD RULE block grew organically over the testing days (preserve words,
  preserve block kind, use `kinds` filter, mandatory pre-flight checks).
  If/when a second agent needs to do block-level edits (e.g. a future
  "Code Reviewer" agent editing pages, or Phase 4's split tool needing a
  doc surgeon), extract the rule set into a shared skill so the wisdom
  isn't trapped in one agent's `system_prompt`. Skills already support
  this shape (text + tool_slugs); the pattern matches `rich_writing`,
  which Pages + Saskia both attach. Don't extract prematurely — premature
  abstraction is its own cost; do it when the duplication actually arises.
  Origin: 2026-05-27 testing conversation, Alex's prompt: *"we must
  remember Skills... maybe design a more structured ruleset for the
  models that does tasks like pages."*

- **Hierarchy / sub-pages (Phase 4)** — **4a + 4b + 4c shipped.**
  The architectural lever for documents past ~50 KB. Insight
  (2026-05-27 audit conversation): no model AND no human reads a 170 KB
  document as one unit. The right answer to "this doc is too long for Pages
  to restyle" is not "make Pages handle bigger docs" — it's structure. Notion
  does this via sub-pages; Mantle's `nodes.parent_id` + `ltree path` already
  support the tree at the data layer, just not at the UX or content-model
  layer.

  Three slices, in order:

  - **4a — Manual sub-pages** — ✅ **built (2026-05-28).** What makes Mantle
    a Notion peer.
    1. TipTap block-level atom node `childPage` with attrs
       `{ pageId, title, icon? }` (`components/page-editor/child-page.ts` +
       `child-page-view.tsx`) — renders as a clickable card linking to
       `/pages/<pageId>`; the block-level cousin of `PageMention`. The card
       refreshes the child's live title/icon on mount so renames show up. In
       the shared `pageExtensions` so PageView renders it too; the public
       renderer emits an inert label (sub-pages aren't part of a shared
       subtree). `childPage` joins `BLOCK_NODE_TYPES` (addressable +
       block-id'd) and `docToText`'s `BLOCK_TYPES`.
    2. `/page` slash command ("Sub-page") creates a page with
       `parent_id = current page`, then inserts a `childPage` card at the
       cursor. The page id reaches the static slash item via a `pageId`
       option on the editor-only `SlashCommand` extension (exposed through
       `editor.storage`); `PageEditor` gained a `pageId` prop. (Inline
       `/page <title>` capture deferred — TipTap's Suggestion stops the query
       at whitespace; the card is created "Untitled" and renamed in-child.)
    3. `/pages` renders as a collapsible tree (built from `parent_id`) when
       no filter is active; search / tag-filter falls back to the existing
       flat paginated list (scattered matches aren't a tree — mirrors Notion).
       Per-row hover actions: add sub-page, delete. Delete-confirm warns when
       the target has sub-pages (`parent_id` is **ON DELETE CASCADE** — a
       parent delete removes its whole subtree).
    4. `createPage` accepts `parentId` (it did NOT before — it hardcoded the
       flat `pages` root): it resolves the parent, sets `nodes.parent_id`,
       and extends the parent's ltree `path` (`pages.<childId>`, nesting
       deeper for grandchildren). Bad parent → `ParentPageNotFoundError` →
       400 at `POST /api/pages`. New helper `listChildPages(ownerId, parentId)`.
       The tree is driven by `parent_id` (the reliable FK); the ltree path is
       the materialised mirror. Zero schema cost.

  - **4b — `page_split` tool for Pages** — ✅ **built.** The AI-driven
    scaling lever. Signature: `page_split({ page_id, by: 'h1' | 'h2',
    preserve_intro?: boolean })`. Walks the doc, every Hx heading becomes
    a child page's title, content until the next Hx becomes the child's
    body. Original page becomes a TOC of `childPage` blocks. Server-side,
    deterministic, byte-faithful (blocks redistributed, never rewritten —
    same object refs; see [`page-split.ts`](../packages/content/src/page-split.ts)).
    The pure splitter is `splitDocByHeading`; `splitPage` (pages.ts) wraps
    it: children via `createPage` (the `nodes` insert fires the extractor →
    each child indexed independently), parent TOC written to **`draft_doc`
    only** (reviewable; the agent has no commit tool). Operates on
    `draft ?? doc`. Lands in the `pages` tool group (so the Pages agent
    holds it); the persona proposes a split when a whole-doc transform is
    too large. Indexing win: search becomes granular ("find the section
    about X" returns a child page, not a haystack) — the brain gets
    *better*, not just smaller per-page.

  - **4c — Promote-to-sub-page** — ✅ **built.** The surgical cousin of 4b:
    lift ONE section into a sub-page. Pure core `extractSection`
    ([`page-split.ts`](../packages/content/src/page-split.ts)) finds the
    top-level heading by block id, takes everything from it until the next
    heading of **equal-or-higher level** (an h2 section ends at the next h2
    or h1), and returns the section body + the surrounding `before`/`after`
    blocks. `extractSectionToChild` (pages.ts) wraps it like `splitPage`
    (child via `createPage` → indexed; parent rewritten to `draft_doc`).
    Two surfaces: the agent tool `page_extract_section({ page_id,
    heading_block_id })` (in the `pages` group), and a **drag-handle
    "Extract to sub-page"** action shown on top-level headings
    ([`drag-handle.tsx`](../apps/web/components/page-editor/drag-handle.tsx)) —
    client-side mirror that reuses the same `extractSection`, creates the
    child via `POST /api/pages` (with its body), and swaps the section for a
    `childPage` card (autosaved to draft like any edit).

  Pages persona update (lands with 4b): when a request like "restyle this
  X-block document" exceeds a threshold, Pages PROPOSES a split first
  rather than attempting the full transform. Stops pretending to scale
  infinitely; starts coaching the user toward the right structure.

  Bonus effect: the section-highlighting feature (an earlier Phase 3a.2
  proposal) becomes less urgent — most "restyle a region" asks become
  "restyle this sub-page", which is just a normal AI-assist call on a
  smaller page.

  Why this is the right shape:
  - Data layer already supports it (parent_id + ltree). Zero schema cost.
  - Matches how humans organise long content (the Notion paradigm).
  - Each child stays within Pages's current iteration budget cleanly,
    no architectural tuning needed.
  - Each child is independently searchable, shareable, editable.
  - The "wall of text" problem is dissolved at the model level, not
    worked around at the tool level.

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
