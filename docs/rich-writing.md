# Rich writing — Saskia writes Notion-style documents

> The web `/assistant` renders Saskia's replies as rich documents — callouts,
> columns, tables, to-do lists, highlights — through the **same TipTap engine
> the Pages feature uses**. Her ability to *author* that formatting is a
> **skill** (`rich_writing`); the chat's ability to *render* it is a small
> markdown→HTML bridge into the Pages schema. With the same dialect she can also
> **create/update/delete real Pages** via the `page_*` tools — a saved page
> renders identically to the reply she showed.
>
> Companion docs: [`pages.md`](./pages.md) (the editor schema + custom nodes),
> [`heartbeats.md`](./heartbeats.md) (how skills attach to agents).

---

## 1. Why this is split in two

Two independent pieces, deliberately:

1. **The skill** (`apps/web/scripts/seed-rich-writing-skill.ts`) — teaches
   Saskia *what* to write. It's a normal Mantle skill: instructions appended to
   the agent's system prompt by `composeSystemPromptWithSkills`
   ([`lib/skills.ts`](../apps/web/lib/skills.ts)), attached via
   `agents.skill_slugs[]`. Pure data through the existing seam — no pipeline
   code. Toggle/edit it at `/settings/skills`.
2. **The renderer** — makes the chat *show* it. `richMarkdownToHtml`
   ([`lib/rich-markdown.ts`](../apps/web/lib/rich-markdown.ts)) converts her
   dialect to HTML; `<RichText>`
   ([`components/assistant/rich-text.tsx`](../apps/web/components/assistant/rich-text.tsx))
   feeds it to a read-only TipTap editor built on the **shared `pageExtensions`
   schema**, so chat output renders identically to a page and reuses the
   ProseMirror CSS in `globals.css`.

The skill's instructions and the renderer's parser are a **contract**: the
dialect documented in one must match the other. Edit them together.

---

## 2. The dialect

Plain GFM markdown, plus three constructs markdown lacks. They map 1:1 onto the
Pages custom nodes (`callout`, `columnList`/`column`) whose `parseHTML` rules
key off `data-*` attributes.

| Construct | Syntax | Renders as |
|---|---|---|
| Headings / bold / italic / code / quote / lists / links / `---` | standard markdown | StarterKit nodes |
| Table | GFM pipe table | `TableKit` |
| Highlight | `==text==` | `<mark>` (Highlight) |
| Colour | `[text]{color=chart-2}` / `[text]{highlight=chart-3}` (chart-1..5; both keys may combine) | `textColor` mark / themed `highlight` |
| To-do list | `- [ ]` / `- [x]` | TipTap `taskList` |
| Callout | `:::info` … `:::` (variants: `info`, `success`, `warning`, `danger`) | `callout` node + NodeView |
| Aside | `:::aside` … `:::` (optional themed colour: `:::aside chart-3`) | `aside` node + NodeView (themed gradient) |
| Columns | `:::columns` … `+++` … `:::` (2+ parts) | `columnList` ⊃ `column` |
| Image | `![alt](url)` | `image` node (block, by URL) |
| Math | `$inline$` / `$$block$$` | `inlineMath` / `blockMath` (KaTeX) |

```
:::warning
This is destructive — there's no undo.
:::

:::columns
### Pros
- fast
+++
### Cons
- less context
:::
```

**Constraints** (enforced by the parser, taught by the skill):
- Containers don't nest (no callout/aside-in-callout/aside, no columns-in-columns).
- `:::columns` needs ≥2 parts split by a lone `+++`, else it degrades to plain.
- Every `:::` block must be closed on its own line.
- Rich rendering is **web-only**. Telegram/voice surfaces stay plain text — the
  skill says so explicitly.

---

## 3. How it flows

```
Saskia (system prompt has the rich_writing skill)
  → emits dialect markdown as her reply text (stored in assistant_messages.text)
  → /assistant client groups messages into turns
  → <RichText> : richMarkdownToHtml(text) → HTML → read-only TipTap (pageExtensions)
  → renders callouts / columns / tables / tasks, themed by the active theme
```

Nothing changes server-side: `runAssistantTurn` already resolves + composes
attached skills. The reply is plain text in the DB (history replays it as text
to the model); the richness is purely a *rendering* of that text.

---

## 4. The document layout

The `/assistant` page is a **document canvas**, not a chat transcript
([`assistant-client.tsx`](../apps/web/app/(app)/assistant/assistant-client.tsx)):

- Messages are grouped into **turns** (`prompt` + `response`).
- Each turn is a grid row: Saskia's response is the wide reading column (the
  document); the user's prompt floats in a **right margin** (`lg:col-start-2`),
  anchored to the response it produced (sticky within its turn).
- The composer docks right on wide screens — the user's side of the page.
- Stacks (prompt above response) below `lg`.

---

## 5. Page authoring tools

Saskia can create/update/delete real Pages from the same dialect. The bridge is
`markdownToDoc` ([`packages/content/src/markdown-to-doc.ts`](../packages/content/src/markdown-to-doc.ts)) —
the inverse of `docToText` — which converts the dialect to the ProseMirror JSON
pages store (`pages.doc`). The builtins live in
[`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts):

| Tool | Args | Notes |
|---|---|---|
| `page_create` | `title, markdown, tags?, icon?` | indexed into the brain on create |
| `page_update` | `id, markdown? \| title? \| tags? \| icon?` | `markdown` replaces the whole body + re-indexes |
| `page_get` | `id` | returns title/tags/summary + body as plaintext |
| `page_list` | `query?, tag?, limit?` | newest first, bodies omitted |
| `page_delete` | `id` | `requires_confirm` (irreversible) — pauses for approval |

Because both the chat renderer and `markdownToDoc` parse the *same dialect*, a
saved page looks identical to the reply Saskia showed. (Two parsers today —
chat→HTML, page→JSON — kept in sync by this doc; unifying on `markdownToDoc` for
both is a future cleanup.)

---

## 6. Applying the skill + tools

```
ALLOWED_USER_ID=<uuid> pnpm --filter @mantle/web run seed:rich-writing
# or target a specific agent:
ALLOWED_USER_ID=<uuid> AGENT_SLUG=saskia pnpm --filter @mantle/web run seed:rich-writing
```

Idempotent. The script now also `seedBuiltinTools` (so the `page_*` rows exist)
and the `rich_writing` skill carries the page tool slugs in its `tool_slugs` —
so attaching the skill **also grants the page tools** (via `effectiveToolSlugs`).
Auto-targets the highest-priority enabled `assistant` (falls back to a
`responder`). No agent restart needed for the web surface — tools are read from
the table per turn.

---

## 7. Known edges / deferred

- **Mentions** (`@entity` / `@page` chips) aren't emitted by Saskia yet — they
  need real node/entity ids. The schema renders them if present; authoring them
  is a follow-up (would let her cite the brain inline).
- **One TipTap editor per Saskia turn.** Fine for normal threads; if very long
  histories feel heavy, switch `<RichText>` to a static `generateHTML` pass +
  callout CSS (loses the live NodeView, gains speed).
- **Two dialect parsers** (chat HTML vs page JSON). Unify both on `markdownToDoc`
  + `<PageView>` JSON rendering when convenient.
- **`page_update` replaces the whole body.** No partial/section edit — the agent
  reads with `page_get` then sends a full revised body.
