# Journal

> The brain's **experience log**, two lanes in one node type. The **user lane**
> holds durable self-knowledge (who you are, what you expect) that every agent
> carries into every conversation. The **agent lane** is the agents' own
> working log — lessons from real outcomes, expectations the user holds them
> to, and **open questions** the brain wants answered (the gap loop). Entries
> ride the `nodes` table like notes, flow through the extractor for
> search/recall, and are distilled into two always-on prompt blocks.

Shipped 2026-06-04 as a mood-diary; **v2 (2026-08-24) stripped emotions and
added the agent lane + gap loop**. Node type `journal`, route `/journal`,
sidebar **"Journal"**. Design page: dev-brain `a28faa36`.

---

## 1. Why this exists

Notes are quick-capture; Pages are rich docs; Tables are structured data;
facts are extracted world knowledge. None of them are *about the user*, and
none of them are a place for an agent to deliberately record what it has
learned about doing its job. The journal is both:

- The user (or an agent, on request) writes durable self-knowledge, and every
  agent carries it into every conversation without the user re-explaining.
- An agent writes what a new employee would write in a logbook: "this worked",
  "the user expects X of me", "I could not do my job because I do not know Y".
  The last kind is a question the brain then **asks the user** — in chat when
  relevant, or in the UI — and the answer is journaled so it is never asked
  twice.

v1's moods (happy/sad/anxious…) are gone: emotional snapshots churn hour to
hour and taught the agents nothing durable, and on a work/specialist brain
they made the whole feature dead weight.

Entries are intentionally **short plain-text paragraphs** (no markdown editor)
so they stay atomic and chunk cleanly into the context blocks.

---

## 2. Shape (`type='journal'`)

Lives entirely in `nodes.data` (no sidecar, the Notes/Contacts pattern):

```ts
data = {
  body: string,          // the entry — a short first-person paragraph
  author: 'user'|'agent',// provenance — stamped SERVER-SIDE, never model args
  agent_slug?: string,   // authoring agent when author='agent'
  kind?: string,         // identity·context·preference·goal | lesson·expectation·gap
  status?: string,       // gap lifecycle: 'open' | 'resolved' (kind='gap' only)
  resolved_at?: string,  // stamped when a gap is resolved
  entry_date?: string,   // optional ISO date the entry is "about" (validated)
  // extractor adds: summary, summary_model, summary_at, entities
}
```

**Kinds, two lanes** (`packages/content-core/src/journal-options.ts`, a
browser-safe leaf with no `@mantle/db` import — the client editor/filters
import it without dragging `postgres` into the bundle):

| lane | kinds | renders in |
|---|---|---|
| user | `identity`, `context`, `preference`, `goal` | `# About the user` |
| agent | `lesson`, `expectation`, `gap` | `# Working notes` |

**Legacy rows** (pre-v2) carry `mood`/`category` in jsonb. Nothing reads
`mood` anymore. `category` maps to a kind at read time
(`legacyCategoryToKind`: identity→identity, goal→goal, everything else→
context). No migration, no backfill.

`nodes.title` is an optional short title, auto-derived from the first
sentence / ~60 chars of `body`. All entries live under the lazy-created
`journal` ltree root. Tags are the usual `nodes.tags`.

The CRUD module is `packages/content/src/journal.ts`:
`listJournals`/`countJournals`/`listJournalTags`/`getJournal`/`createJournal`/
`updateJournal`/`deleteJournal`/`resolveGapEntry`. List filters: `query`,
`kind` (legacy-aware SQL mapping), `author`, `status`, `tag`. Sort is
newest-first by the entry's "about" date, else its update time, via the shared
`journalSortSql()` helper.

**`entry_date` is validated, and the sort is crash-proof** — unchanged from
v1: `normalizeEntryDate` rejects non-dates at create/update (REST returns
`400`), and `journalSortSql()` only casts values matching `^\d{4}-\d{2}-\d{2}`,
so a legacy bad row can't crash the list or the context blocks.

**Provenance is server-stamped.** `createJournal` takes `author`/`agentSlug`
from the CALLER (tool loop `ctx.agent`, REST session), never from
model-supplied arguments — an agent cannot spoof a user-authored entry.

---

## 3. Extractor handoff

`journal` is in `DEFAULT_EXTRACT_TYPES` (`server/api/src/agent/extractor.ts`).
`readNodeBodyRaw` frames the entry by lane: user-lane gets a `Kind:` line;
agent-lane gets `Working note from agent <slug> (<kind>)`, so summaries and
facts read as durable operational knowledge rather than an event. Summary +
768-dim embedding + facts + `content_chunks` land like any node, so
`search`/`search_chunks`/recall find entries too. Resolved gaps stay indexed —
they document decisions.

**Cost-safe edits:** only a **body change** clears the cached
summary/embedding and fires `pg_notify('node_ingested')`. Editing the kind,
status, date, or tags is metadata-only — no re-extraction.

---

## 4. The two always-on context blocks (the point)

`packages/content/src/identity-context.ts`. Both are **deterministic, no
LLM** — bounded selections of real entries (the project cost-safety rule), so
they can never run the model away, they only change when an entry changes, and
they sit inside the **cached system block**. Both are thin DB wrappers over
pure, unit-tested renderers.

**`# About the user`** — `buildIdentityContext(ownerId)` →
`renderIdentityBlock`: user-lane entries grouped by kind (`## Identity`,
`## Context`, …, unknown → `## Other`), ≤6 per group, ≤30 total, ≤280 chars
each. Gated per-agent by `AgentMemoryConfig.inject_journal` (default on for
conversational agents).

**`# Working notes`** — `buildWorkingNotesContext(ownerId, agentSlug)` →
`renderWorkingNotesBlock`: agent-lane entries, **shared across agents** (v1
decision) with `_(learned by <slug>)_` attribution when the author isn't the
current agent. `## Expectations` + `## Lessons` (≤6 each) + an
`## Open questions` tail (≤5 open gaps) that carries the ask/record
instructions inline. Gated by the new `AgentMemoryConfig.inject_working_notes`
knob (migration-free jsonb; default on for the persona, **off** for the team
responder — owner-internal context never reaches an external member).

**Injection seam.** `assembleResponderTurn`
(`packages/runtime/src/assistant/assemble-turn.ts`) prepends identity +
working notes before the persona/skills prompt, inside cache breakpoint 1.
Team turns pass `includeIdentity: false`, which gates BOTH blocks.

---

## 5. The gap loop

1. **Capture.** Mid-task, an agent hits a knowledge hole → `journal_create`
   with `kind='gap'`: one answerable question, written to be answered cold.
   Born `status='open'`.
2. **Ask.** Every conversational agent sees open questions in its Working
   notes. The `gap_questions` manifest skill teaches the etiquette: ask only
   when relevant to the current conversation, at most one per turn, never as
   an opener, drop it if declined. The UI's "Questions for you" view (jackdaw
   P2, including a home-screen block) is the out-of-chat path.
3. **Resolve.** The user answers (in chat or UI) → `journal_resolve_gap` (tool)
   or `POST /api/journal/:id/resolve` (UI): the gap gets
   `status='resolved'` + `resolved_at` (audit trail kept) and the answer lands
   as a NEW user-lane entry (default kind `context`), flowing into
   `# About the user` and the index. The question leaves every agent's list
   immediately.

Anti-noise guardrails: hard caps in both blocks, one question per turn max
(taught, and cheap to ignore), delete stays confirm-gated off the auto-grant.
Gap creation only happens inside an existing turn — no cron, no trigger.

---

## 6. REST + UI

- **REST**: `server/web/app/api/journal/route.ts` (GET list — `q`/`kind`/
  `author`/`status`/`tag` filters — and POST create, stamped `author='user'`) +
  `[id]/route.ts` (GET, PATCH, DELETE) + `[id]/resolve/route.ts` (POST — the
  UI's resolve path). `lib/journal.ts` re-exports the content CRUD. Create
  logs a `journal_create` ingest trace.
- **UI** (jackdaw `/journal`, P2 of the v2 rollout): three views — **You**
  (user lane), **Agent notes** (agent lane, grouped by agent), **Questions for
  you** (open gaps with an inline answer box) — plus a home-screen questions
  block. Mood emoji/filter/select are gone; kind chips replace category chips.
  Editing or retiring an agent note in the UI is the human "employee review";
  curation stays human, distillation stays deterministic.

---

## 7. Agent + MCP tools

`packages/tools/src/builtins-journal.ts`:

- `journal_list` (kind/author/status filters) · `journal_get` ·
  `journal_create` (kind REQUIRED — forces the lane choice; provenance
  stamped from `ctx.agent`) · `journal_update` · **`journal_resolve_gap`**
  (the two-write resolution) · `journal_delete` (`requiresConfirm`).
- Auto-grant (`JOURNAL_AUTO_GRANT_SLUGS` = the manifest `journal` tool group):
  everything except delete, which rides `journal-admin`.
- MCP serves the same builtins through the shared registry; a Claude
  Desktop/Code call has no `ctx.agent`, so upstream-ingest entries record as
  the user — correct, it's the user's surface.

Tool descriptions steer the lanes: user-lane on the user's explicit ask;
agent-lane for the agent's own lessons/expectations/gaps; never world-facts
(extractor's job), never tasks/events/secrets.

---

## 8. Manifest

- Skill `gap_questions` (`MANIFEST_SKILLS` + `SKILL_INSTRUCTIONS`), attached to
  the persona — body force-syncs to existing brains on upgrade, and the
  persona link converges by role.
- Persona `memoryConfig.inject_working_notes: true`; team responder `false`.
- The `journal` tool group gains `journal_resolve_gap` (membership
  overwrite-syncs on upgrade).

---

## 9. Tests

Pure-logic unit tests beside the source (`pnpm vitest run packages/content
packages/content-core`):

- `journal-options.test.ts` — `normalizeEntryDate` (unchanged guards), the
  two-lane kind vocabulary, `kindLabel`, `kindLane`, `legacyCategoryToKind`.
- `journal.test.ts` — `deriveTitle`.
- `identity-context.test.ts` — `renderIdentityBlock` (kind grouping, Other
  bucket, 6/30 caps, truncation, **no mood tag ever**) +
  `renderWorkingNotesBlock` (headings order, resolved-gap exclusion,
  cross-agent attribution, 6/6/5 caps, lane isolation).
- `server/api/src/agent/core-tools.test.ts` pins the journal group contents
  (now including `journal_resolve_gap`).

The DB wrappers and UI aren't unit-tested (no jsdom); verify live on the dev
stack per §10.

---

## 10. Rollout (the two-repo order)

`journal-options.ts` and `JournalRow` live in published contract packages
(`@crossworks/content-core`, `@crossworks/client-types`) consumed by jackdaw:

1. **Mantle P1** (this doc's state): vocabulary, CRUD, distillers, seam,
   tools, extractor, REST, manifest, tests, docs.
2. Publish contract packages; bump the jackdaw `file:` pin by **replacing the
   copy** (never symlink).
3. **Jackdaw P2**: `/journal` three-view UI + home-screen questions block +
   mood strip. Ships as a client pair.
4. **P3 (later)**: reflector proposes agent-lane entries instead of hidden
   persona notes; structured in-chat question widget (runner `ask_human` is
   prior art).

## 11. Deliberately deferred (not v2)

- **LLM-distilled profile**: both blocks stay deterministic selections; the
  seams (`buildIdentityContext` / `buildWorkingNotesContext`) are the single
  places to swap in an LLM compression later.
- **Public sharing**: journal entries are private by nature; no `ShareControl`.
- **Dedupe-on-create for agent entries**: v2 relies on the skill's
  "check the list first" instruction + human curation; a similarity gate can
  land in the create path later without contract changes.
