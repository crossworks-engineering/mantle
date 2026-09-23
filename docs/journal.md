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

**Legacy rows** (pre-v2) carry `mood`/`category` in jsonb. `category` maps to
a kind at read time (`legacyCategoryToKind`, mirrored in `journalKindSql`):
identity→identity, goal→goal; the background life areas family,
relationships, faith and health→identity, unless the row carries a `mood` (a
mood-era entry reflects on a moment)→context; everything else→context. The
mood is read only for that split. No migration, no backfill. (Spike 10: with
every background area mapped to context, a personal brain's family, faith and
health baseline fell off the always-on block.)

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

### 4a. Tiers (`memory_config.journal_tiers`, 2026-09-23)

Spike 10 (dev-brain page 60a2f51e) found three faults in the two blocks above:
newest-first caps showed the wrong entries (six cut-off release notes as
"About the user" on dev; a personal brain's background entries silently
dropped), every Journal write re-billed the whole cached prefix (it sits in
front of the persona prompt), and relevance played no part. The tiers replace
them, per agent:

| `journal_tiers` | What the prompt gets |
|---|---|
| `off` | the two blocks above; no per-turn lookup |
| `shadow` (default) | the two blocks above; tiers 2 + 3 are picked and recorded in the `load_context` snapshot (`snapshot.journal`) only |
| `live` | the tiers below; the two blocks above are gone |

`notes_target = 'journal'` (§4b) implies `live` whatever `journal_tiers` says
(`journalTiersOf`): the agent's notes then exist only in the Journal, and the
old capped blocks would show about 6 of hundreds.

**Scope.** A rule an agent learned belongs to that agent: other agents do not
see it, in any block or tier. A learned rule is a lesson or expectation, or
any entry that came from the agent's own learning (`data.source.via` =
`reflector` / `update_persona`, or `data.source.persona_note_ref`), with
`agent_slug` set (`isLearnedRule`, `visibleToAgent`). What an agent RECORDS
for the user (`journal_create` of "I'm vegetarian", a resolved gap's answer)
is the user's knowledge and stays brain-wide whoever wrote it, as do entries
with no agent and open gaps. Superseded entries (`nodes.superseded_by`) never
show. Decided 2026-09-23, when persona notes, which were per agent, moved
into the Journal. A learned rule keeps its `source` through edits, so it
stays scoped; to share one agent's rule with every agent, re-create it as a
plain entry (no agent). The scope SQL has a real-Postgres test,
`packages/content/src/journal-scope.db.test.ts` (gated on
`MANTLE_TEST_DATABASE_URL`).

- **Tier 1, always on** (`buildJournalTier1` → `planJournalTier1` →
  `renderJournalTier1Block`): the purpose block + the identity / goal /
  preference entries the agent may see, full text (≤1,500 chars each),
  grouped by kind, oldest first by `created_at`, so a new entry appends and an
  edit never reorders. The block holds 16,000 chars: each kind first fills its
  own share (identity 4,000, goal 2,000, preference 10,000), oldest first,
  stopping at the first that does not fit; then what is left of the 16,000
  is shared in kind order. A new entry never pushes out an older one of its
  own kind. An entry that does not fit **overflows to tier 2** and to the
  rules `journal_recall` scores: it is then picked per turn, by Jev when that
  use is on, otherwise by similarity, which rarely matches a standing rule
  (turn `journal_recall` on for an agent whose rules overflow).
  `snapshot.journal.tier1` counts shown and overflow. It rides the
  **persona-notes block** (cache marker 2), after the persona prompt: a Journal
  write re-bills that block onward, never the persona prompt.
  `assembleResponderTurn` returns it as `journalBlock`; `buildChatMessages`
  renders it.
- **Tier 2, per turn** (`journalTiersForTurn`, runtime
  `conversation/journal-tiers.ts`, with the turn's one query embedding): every
  non-gap entry not shown in tier 1 (context entries, free-text user kinds,
  lessons, expectations, tier 1 overflow) whose cosine similarity to the
  message is at least `journal_relevance_min` (default 0.70, clamped 0 to 1;
  ~0.60 suits long work logs, 0.72 to 0.75 short personal entries). Best
  first, ≤6 entries, ≤`journal_relevant_chars` (default 3,000, clamped 200 to
  20,000) a turn. A body over 1,200 chars sends its best-matching chunk, not
  the whole; a pick cut to fit the budget is dropped when under 80 chars.
  Greetings, thanks and acknowledgements skip the lookup (`isSmallTalk`; a
  one-word request such as "invoices" is not small talk). The scan is a plain
  distance select over the agent's visible entries (not an index walk a type
  filter would starve), capped at 5,000 rows.
  With the decider's `journal_recall` use live, the rules Jev scored are
  picked by score instead (≤25 rules, ≤6,000 chars): similarity cannot match a
  rule to a request (spike 13, decisions.md §4). A rule Jev did not score (its
  group failed) falls back to similarity, and a scored rule with no embedding
  yet is still a candidate. In shadow, Jev's pick is traced beside the
  similarity pick from the same candidate load (`snapshot.journal.recall`).
- **Tier 3, per turn**: at most one open gap whose similarity passes the same
  cutoff, with the ask/record instructions.
- Tiers 2 + 3 render as `# From the Journal (relevant to this message)`, an
  **uncached** system block right after the volatile context
  (`ctx.journalRelevant`). In `live`, what a **whole** entry in the prompt
  (tier 1, or a tier 2 pick sent in full) makes redundant is dropped: facts
  extracted from it, its chunk hits and its content hit. A passage pick drops
  only its own chunk. `snapshot.journal.dedupe` counts them in both modes.
- The embedding is computed when the tiers need it, even with `fact_limit`
  and `content_hit_limit` at 0. Passages, context pruning and version
  grouping still ride only on the retrieval an agent asked for, so an
  embedding computed for the tiers alone does not switch them on.
- If the tier 1 plan cannot be loaded, tier 2 leaves out every tier 1 kind,
  so no entry can show twice.
- Lanes stay gated: `inject_journal` (user lane, and with it tier 1) and
  `inject_working_notes` (agent lane). Team and forum turns never render the
  Journal, so they call `loadConversationContext` with `includeJournal:
  false`: the tiers do not run there, spend no decider call and drop nothing.
- The legacy mapping (a family / relationships / faith / health row with no
  mood reads as identity) applies to the old blocks too, so with `off` or
  `shadow` such rows moved from "Other" into the identity group.

To go live on one agent: set `memory_config.journal_tiers` to `live` (the
agent PATCH route accepts it, with the clamps above); read a few
`load_context` snapshots first (`snapshot.journal.picked`, `nearMisses`,
`tier1`) and tune `journal_relevance_min` for that brain.

### 4b. Persona notes move into the Journal (`memory_config.notes_target`)

Persona notes (`agents.persona_notes`, written by the reflector and
`update_persona`) and the Journal's agent lane hold the same thing: what an
agent learned about helping its user. The notes ride every prompt in full and
were never retired (spike 13, dev-brain page 9f57fa46: one work brain held 503
notes, 103k chars, 68 of them general and 435 topic rules). The move, per
agent (both runs spend, so both take `--yes`; the task runs from a terminal
only, since it needs `--agent` or `--page`):

1. **Dry run:** `pnpm maintain persona-notes-to-journal --agent=<slug> --yes`.
   Inside a box's container the owner id is not in the environment:
   `docker exec -w /app -e ALLOWED_USER_ID=<owner id> mantle_web pnpm maintain persona-notes-to-journal --agent=<slug> --yes`.
   The agent's own model sorts every live note at low reasoning effort, in
   batches of 15 with one retry each (general → `preference` / `identity`,
   tier 1; topic → `expectation` / `lesson` / `context`, tier 2; a correction
   is always general). Answers are checked; a note with no usable answer is
   "unsorted" and goes per turn, listed on the page. A batch that still fails
   leaves its notes unsorted instead of ending the run. Near-copies are merged
   (embedding ≥ 0.85, confirmed by the model); a group keeps its strongest
   note (a correction, then a general note, then the earliest). The plan goes
   to a review page (the plan itself in the page's `data.persona_notes_plan`),
   which warns when the always-on notes outgrow tier 1 (16,000 chars, shared
   with the user's own entries). Measured 2026-09-23:
   $0.79 for 503 notes on Sonnet 5, $0.12 for 119 on grok.
2. **Apply:** `pnpm maintain persona-notes-to-journal --apply --page=<id> --yes`
   checks the stored plan and its agent, then creates exactly the reviewed
   entries, authored as the agent (so they belong to it), tagged
   `from-persona-notes`, `data.source.persona_note_ref` set (idempotent).
   Notes retired since the dry run are skipped; notes learned since are
   reported (re-run the dry run for them). No sorting call, but each new
   entry is indexed, which runs the extractor once per entry. Persona notes
   untouched.
3. **Switch:** set the agent's `memory_config.notes_target` to `journal`.
   This also switches its tiers live (§4a). The agent stops reading its
   persona notes; the reflector reads this agent's rule entries (identity,
   goal, preference, lesson, expectation; newest 300, each cut to 240 chars)
   as "already known" and writes Journal entries (it also gives each note a
   `scope`: general → `preference`, topic → `expectation`; relationship →
   `identity`; correction → `preference`), dropping near-copies of what the
   agent knows (token Jaccard ≥ 0.6). `update_persona` always writes a general
   `preference` (an explicit request, and a correction must land even when it
   reads like the rule it replaces); its `supersede_refs` do not apply in the
   Journal, and the tool says so: retiring the old entry is `journal_list`,
   then `journal_update` / `journal_delete`.
4. Rules then reach the prompt through tier 2, picked by Jev when the
   decider's `journal_recall` use is live (embedding similarity cannot match
   a rule to a request).

There is no one-step undo: the converted entries carry the
`from-persona-notes` tag, and setting `notes_target` back to `persona` makes
the agent read its (untouched) persona notes again.

---

## 5. The gap loop

1. **Capture.** Mid-task, an agent hits a knowledge hole → `journal_create`
   with `kind='gap'`: one answerable question, written to be answered cold.
   Born `status='open'`.
2. **Ask.** Every conversational agent sees open questions in its Working
   notes (with the tiers live, only the one open gap that matches the message
   joins a turn: tier 3, §4a). The `gap_questions` manifest skill teaches the etiquette: ask only
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
