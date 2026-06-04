# Life Logs

> A personal life log that teaches agents **who you are**. Short, first-person
> entries — what you do, who you are, what you're thinking, sad/happy/anxious —
> each with an optional **mood** and **life-area category**. They ride the
> `nodes` table like notes, flow through the extractor for search/recall, and
> are distilled into an **always-on identity block** injected into every agent
> turn. Looks and behaves like [Notes](./content.md): list on the left, a
> form on the right.

Shipped 2026-06-04. Node type `lifelog`, route `/lifelog`, sidebar **"Life Logs"**.

---

## 1. Why this exists

Notes are quick-capture; Pages are rich docs; Tables are structured data. None
of them are *about the user*. The assistant ("Saskia") only knew the user
through scattered facts the extractor happened to pull from other content. Life
Logs are the deliberate, first-person channel: the user (or the assistant, on
request) writes down durable self-knowledge, and **every agent carries it into
every conversation** without the user re-explaining themselves.

Entries are intentionally **short plain-text paragraphs** (no markdown editor)
so they stay atomic and chunk cleanly into the identity context.

---

## 2. Shape (`type='lifelog'`)

Lives entirely in `nodes.data` (no sidecar — the Notes/Contacts pattern, not
the Pages/Tables sidecar pattern):

```ts
data = {
  body: string,          // the entry — a short first-person paragraph
  mood?: string,         // happy·grateful·calm·excited·hopeful·reflective·tired·anxious·sad·angry
  category?: string,     // identity·work·family·relationships·faith·health·emotion·goal·reflection
  entry_date?: string,   // optional ISO date the entry is "about" (validated; defaults to created_at)
  // extractor adds: summary, summary_model, summary_at, entities
}
```

`nodes.title` is an optional short title — **auto-derived from the first
sentence / ~60 chars of `body`** when the user leaves it blank, so the left
list stays readable. All entries live under the lazy-created `lifelog` ltree
root. Tags are the usual `nodes.tags`.

Mood + category option lists are a **browser-safe leaf**
(`packages/content/src/lifelog-options.ts`, no `@mantle/db` import) so the
client editor/filters import them without dragging `postgres` into the bundle
— same discipline as `contacts-format.ts`. `lifelog.ts` re-exports them.

The CRUD module is `packages/content/src/lifelog.ts`:
`listLifelogs`/`countLifelogs`/`listLifelogTags`/`getLifelog`/`createLifelog`/
`updateLifelog`/`deleteLifelog`. List sort is newest-first by the entry's
"about" date, else its update time — via the shared `lifelogSortSql()` helper.

**`entry_date` is validated, and the sort is crash-proof.** Because the sort
casts `data->>'entry_date'` to `timestamptz`, an unparseable value would
otherwise throw and break the *entire* list (and the identity block). Two
guards prevent that: (1) `normalizeEntryDate` (in the browser-safe
`lifelog-options` leaf) coerces any create/update input to canonical ISO or
**rejects** it — `createLifelog`/`updateLifelog` throw, and the REST routes
return `400` — so non-dates (`"next Tuesday"`) never reach the DB; (2)
`lifelogSortSql()` only casts values matching `^\d{4}-\d{2}-\d{2}`, otherwise
falling back to `updated_at`, so even a legacy or directly-written bad row
can't crash the query.

---

## 3. Extractor handoff

`lifelog` is in `DEFAULT_EXTRACT_TYPES` (`apps/agent/src/extractor.ts`).
`readNodeBodyRaw` frames the entry as `title` + `Area:` + `Mood:` + body, so
the summary/facts read as durable self-knowledge ("works as…", "values…",
"felt anxious about…") rather than an event. Summary + 768-dim embedding +
facts + `content_chunks` land like any node, so `search`/`search_chunks`/recall
find entries too.

**Cost-safe edits:** only a **body change** clears the cached
summary/embedding and fires `pg_notify('node_ingested')`. Editing just the
mood, category, date, or tags is metadata-only — no re-extraction (the body
carries the semantic payload). One extraction per meaningful edit.

---

## 4. The always-on identity context (the point)

`packages/content/src/identity-context.ts` → `buildIdentityContext(ownerId)`
distils the user's life logs into a compact `# About the user (Life Log)`
block, grouped by category (`## Work`, `## Faith`, …), newest-first, with each
entry as one bullet and its mood inline. It's a thin DB wrapper over a **pure,
DB-free `renderIdentityBlock(entries)`** — the grouping/capping/formatting
logic lives there so it's deterministic and unit-tested (see §9).

- **Deterministic, no LLM.** It's a bounded, category-grouped *selection* of
  the user's real entries (≤6 per category, ≤30 total, ≤280 chars each), not an
  LLM summary. So it can never run the model away (the project cost-safety
  rule), it only changes when the user adds/edits a life log, and it sits
  inside the **cached system block** at the same cadence as persona notes — no
  per-turn cost beyond the tokens. (An LLM-distilled profile is a possible
  Phase 2.)
- Returns `''` when the user has no life logs, so the caller's concat is a
  clean no-op.

**Injection seam.** Both conversational surfaces prepend the block right after
`composeSystemPromptWithSkills`, before the cache breakpoint, so it rides the
existing cached persona block (no new breakpoint):

- web `/assistant` — `apps/web/lib/assistant.ts` (`runAssistantTurn`)
- Telegram responder — `apps/agent/src/main.ts` (`handleMessage`)

**Opt-out per agent:** `AgentMemoryConfig.inject_lifelog` (migration-free jsonb
knob on the `agents` row). Defaults to on for responder/assistant agents;
set `false` on a utility/persona-light agent that shouldn't carry it.

---

## 5. REST + UI

- **REST** — `apps/web/app/api/lifelog/route.ts` (GET list, POST create) +
  `[id]/route.ts` (GET, PATCH, DELETE). `lib/lifelog.ts` re-exports the content
  CRUD. Create logs a `lifelog_create` ingest trace.
- **UI** — `/lifelog`, master-detail (the Notes/`useListNav` pattern):
  URL-driven search + **mood** + **category** + tag filters (SSR), a left list
  (mood emoji · category chip · body preview), and a right pane that's either
  the read view or the editor. The editor is a plain `Textarea` + mood/category
  `Select`s + an optional "When" `DateTimePicker` + tags — **no markdown
  editor**, by design. ⌘/Ctrl+S saves, Esc cancels, unsaved-changes guard.

---

## 6. Agent + MCP tools

So the assistant can log on the user's behalf ("remember that I just started a
new job", "log that I'm feeling anxious about the move"):

- **In-app builtins** (`packages/tools/src/builtins-lifelog.ts`):
  `lifelog_list` · `lifelog_get` · `lifelog_create` · `lifelog_update` ·
  `lifelog_delete` (`requiresConfirm`). Auto-granted to responder/assistant
  agents at boot via `LIFELOG_AUTO_GRANT_SLUGS` (read + add/update; **delete
  excluded**, like contacts). `lifelog` is in the `search_nodes` type enum.
- **MCP** (`apps/mcp/src/server.ts`): full `lifelog_{list,get,create,update,
  delete}` — Claude Desktop / Claude Code is the upstream-ingest surface where
  self-facts naturally get added, and adding from there teaches the in-app
  assistant who you are.

Tool descriptions steer the assistant to use Life Logs for **durable
self-knowledge** — not transient task/calendar items (`todo_create` /
`event_create`) or secrets (`secret_create`).

---

## 7. Storage / migration

Migration `0075_node_type_lifelog.sql` adds the `lifelog` enum value (its own
file, like every other `ALTER TYPE … ADD VALUE`). No sidecar table. Production
just needs the migration on deploy; nothing to backfill. (It landed as `0075`
rather than `0074` because a parallel email-allowlist migration took the `0074`
slot — a reminder to check the latest number *and* rebase before assuming a
free one.)

---

## 8. Verification — it works

Verified end-to-end on the dev stack (2026-06-04):

- **HTTP CRUD.** Through the real `/api/lifelog` routes: create (`201`,
  persisted with mood + category + auto-derived title), `?category=` filter,
  `PATCH` (mood update), and `DELETE` all green; the `lifelog` enum insert
  succeeds.
- **Identity distillation.** `buildIdentityContext` grouped a real entry under
  `## Work` with its mood inline — the exact text destined for the system
  prompt.
- **Live injection.** Exercised the actual seam end-to-end
  (`buildIdentityContext` → `composeSystemPromptWithSkills` →
  `buildChatMessages`): the `# About the user (Life Log)` block lands in the
  rendered **system message**, ahead of the persona, carrying the real
  life-log content — i.e. what the model receives every turn.
- **`entry_date` guard.** Confirmed against the DB: an invalid date is
  rejected on create/update, a valid one normalises to ISO, and a
  deliberately-poisoned row no longer crashes `listLifelogs` /
  `buildIdentityContext`.

---

## 9. Tests

Pure-logic unit tests live beside the source (`packages/content/src/*.test.ts`,
run with `pnpm vitest run packages/content`):

- `lifelog-options.test.ts` — `normalizeEntryDate` (valid ISO / bare date /
  free-text rejection / empty / non-string), `moodDisplay`, `categoryLabel`.
- `lifelog.test.ts` — `deriveTitle` (first-sentence, whitespace collapse,
  empty fallback, >60-char truncation).
- `identity-context.test.ts` — `renderIdentityBlock`: empty input, header +
  heading + inline mood, canonical category ordering, the trailing "Other"
  bucket, the per-category cap (6), the total cap (30), and long-body
  truncation.

24 cases; the full content suite (276) stays green. The DB wrapper and the UI
interactions aren't unit-tested (no jsdom) — they're covered by the live
verification above.

---

## 10. Deliberately deferred (not v1)

- **LLM-distilled identity profile** — v1's identity block is a deterministic
  selection of raw entries; an LLM could compress many entries into tighter
  prose. The seam (`buildIdentityContext`) is the single place to swap it.
- **Public sharing** (`/s/[token]`) — life logs are private by nature; no
  `ShareControl` on the detail header (unlike notes/pages).
- **Mood timeline / analytics** — the data is there (mood + entry_date) for a
  later "how have I been feeling?" view.
