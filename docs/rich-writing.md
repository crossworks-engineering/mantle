# Rich writing — Saskia writes Notion-style documents

> The web `/assistant` renders Saskia's replies as rich documents — callouts,
> columns, tables, to-do lists, highlights — through the **same TipTap engine
> the Pages feature uses**. Her ability to *author* that formatting is a
> **skill** (`rich_writing`); the chat's ability to *render* it is a small
> markdown→HTML bridge into the Pages schema.
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
| To-do list | `- [ ]` / `- [x]` | TipTap `taskList` |
| Callout | `:::info` … `:::` (variants: `info`, `success`, `warning`, `danger`) | `callout` node + NodeView |
| Columns | `:::columns` … `+++` … `:::` (2+ parts) | `columnList` ⊃ `column` |

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
- Containers don't nest (no callout-in-callout, no columns-in-columns).
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

## 5. Applying the skill

```
ALLOWED_USER_ID=<uuid> pnpm --filter @mantle/web run seed:rich-writing
# or target a specific agent:
ALLOWED_USER_ID=<uuid> AGENT_SLUG=saskia pnpm --filter @mantle/web run seed:rich-writing
```

Idempotent: upserts the skill by slug, adds it to the agent's `skill_slugs` only
if missing. Auto-targets the highest-priority enabled `assistant` (falls back to
a `responder`).

---

## 6. Known edges / deferred

- **Mentions** (`@entity` / `@page` chips) aren't emitted by Saskia yet — they
  need real node/entity ids. The schema renders them if present; authoring them
  is a follow-up (would let her cite the brain inline).
- **One TipTap editor per Saskia turn.** Fine for normal threads; if very long
  histories feel heavy, switch `<RichText>` to a static `generateHTML` pass +
  callout CSS (loses the live NodeView, gains speed).
- **"Saskia drafts a real Page."** Because she already writes the Pages dialect,
  a `page_create` tool that runs the same markdown→doc bridge is now a small
  step — she could promote a good reply into a saved, indexed page.
