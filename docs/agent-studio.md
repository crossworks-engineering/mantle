# Agent Studio — the overview editor for the agent/skill/worker graph

> **Status: SHIPPED — all four phases** (2026-06, v0.19.11-alpha). Top-level
> `/studio`: P1 read-only overview (per-agent wiring DAG + integrity health +
> composed-prompt preview), P2 prose versioning (git-style history/diff/revert,
> migration 0079 `prompt_versions`), P3 structure editing (model/params/skills/
> delegates inline + reset-to-default), P4 no-persist sandbox. Code in
> `apps/web/lib/studio/` + `apps/web/app/(app)/studio/` + `app/api/studio/`. The
> phased plan below is retained as the design record.
>
> **Update (2026-06, tools/skills reshape — see [docs/tools-and-skills.md](tools-and-skills.md)):**
> the canvas gained **tool-group nodes** + `agent→group` grant edges and a
> read-only group inspector; skill nodes read as "teaching" (skills carry no
> tools). The composed-prompt preview is unchanged — skills are still prose.

## What it is

A **separate, overview-first editor** that sits *beside* the per-node settings
pages (`/settings/agents`, `/settings/skills`, `/settings/ai-workers`) — it does
not replace them. Where the settings pages let you dive into one node and edit it
deeply, the Studio lets you stand back and see (and tune) the **wiring**: which
skills hang off which agents, how their prompts compose, where delegation flows,
and whether every link is healthy.

It is the visual, editable twin of the system-integrity spine
([`docs/system-integrity.md`](system-integrity.md)): the **manifest** is the
factory default, the **DB rows** are the live graph the Studio edits, and
`checkSystemIntegrity` is the live linter that lights every node/edge.

### The governing principle — *no hidden prompts*

The quality of any agent or worker is set by the quality of its prompts. So the
non-negotiable rule: **wherever an instruction is given as human-written prose,
it must be visible and editable here — including its *composition*.** Today the
*assembled* prompt an agent actually runs (system prompt + each attached skill's
instructions, stitched in order) is surfaced nowhere; you have to concatenate it
in your head. The Studio makes the assembled artifact a first-class screen.

## Two layers, two mechanics

The design splits cleanly along a line you draw by hand:

| Layer | What it is | How you edit it | Backing |
|---|---|---|---|
| **Prose** | every human→AI instruction field (the *registry* below) | Fine-tune the text, **with version history + diffs + revert** ("git for prompts") | new `prompt_versions` table |
| **Structure** | model, attached skills, tools, delegates, params | **Wire** it — connect/disconnect edges, swap a model | live `checkSystemIntegrity` linting |

You never prose-diff a model swap, and you never "wire" a paragraph. Prose gets
history+diff; structure gets the graph+health.

### The prose registry — *all human prompts that instruct an AI*

The rule is **not** a hardcoded list — it's "every owner-editable field that holds
human-written instructions to an AI." Today that resolves to:

| Field | Entity | Shape |
|---|---|---|
| `system_prompt` | agent | text blob |
| `instructions` | skill | text blob |
| `system_prompt` | worker (extractor/summarizer/reflector/document) | text blob |
| `extraction_prompt` + `instructions` | worker config (vision, document) | text blob |
| `persona_notes` | agent | **structured** (jsonb `PersonaNote[]`) — `style`/`relationship` calibrations; has its own editor; versioned per-note, not as one blob |

The `*.description` fields (tool / skill / agent / heartbeat) are **catalog
metadata** — labels, not instructions — and stay out of prose versioning.

Because the `prompt_versions` table is keyed by `(entity_type, field)`, any new
human→AI instruction field added in future **auto-enrolls** in the prose layer —
the registry is the source of truth, and a Phase 0 task codifies it so nothing
can hide.

## What it reuses (most of the hard parts already exist)

- **Graph canvas:** `@xyflow/react` v12 + `dagre` — already in `apps/web` deps,
  already used by [`traces`](../apps/web/app/(app)/traces/trace-detail-view.tsx).
- **Live linter:** `checkSystemIntegrity` (`apps/web/lib/system-manifest/`).
- **Prompt composition:** `resolveAgentSkills` + `composeSystemPromptWithSkills`
  ([`apps/web/lib/assistant.ts:227`](../apps/web/lib/assistant.ts)) — the *exact*
  path a real turn runs, so the composed-prompt preview is true to runtime.
- **Per-node editors + tests:** `/settings/agents` (incl. `AgentChatTestButton`,
  a one-shot test through the real path), `/settings/ai-workers` (per-kind test
  buttons), `/settings/skills`.
- **Manifest payoff:** diff-vs-canonical + "reset to default" per node.

## Shape notes (so we don't model it wrong)

- **It's a DAG, not a tree.** Skills are shared across agents; a delegate is
  itself an agent with its own subgraph; delegate-of-delegate can cycle
  (persona → coder, but coder must not delegate back). Guard cycles; render the
  fan-out (a shared skill highlights every agent that pulls it).
- **Agents and workers are different shapes.** Agent node = model → prompt →
  skills → delegates. Worker node = kind → model (→ its prose: system_prompt /
  extraction_prompt). Two node types, two inspectors — don't force one onto the
  other.
- **Owner-only** (`requireOwner`), like `/debug`.
- **Coexists, additive** — no migration of the existing settings pages.

---

## Phases

### Phase 0 — Foundations (small)

- **Top-level `/studio` route** + nav entry (decided).
- `buildAgentGraph(ownerId)` — one batched server read that assembles the whole
  graph (agents, their skills + delegates, workers) into `{nodes, edges}`,
  annotated with `checkSystemIntegrity` status per node/edge. This is the data
  backbone every later phase renders from.
- **Prose registry** — codify the table above as a single declarative list
  (`{entityType, field, label}[]`) that the Studio reads, so "all human prompts
  that instruct an AI" is provable and a new field can't silently escape it.
  (Same single-source-of-truth pattern as the system manifest.)
- Page shell inside the standard Mantle frame (nav/header/activity), full-bleed
  canvas region.

### Phase 1 — The read-only overview ("see everything")

Pure assembly of existing functions; ships fast, near-zero risk.

1. **Wiring graph** (xyflow+dagre): pick an agent or worker → render its
   subgraph. Hover a skill → highlight every agent that shares it. Delegates
   expand to their own subgraph (cycle-guarded).
2. **Health overlay**: each node/edge colored by `checkSystemIntegrity` — the
   visual twin of the System tab; dangling tool/skill links flagged inline.
3. **Composed-prompt preview**: for the selected agent, run the real
   `resolveAgentSkills` + `composeSystemPromptWithSkills` and render the
   assembled system prompt with seams labeled (`— system prompt —`,
   `— skill: tool_grounding —`, …). Clicking a skill/worker node shows its prose
   body (read-only here). **This is the headline — the "no hidden prompts" cure.**

*Deliverable:* open the Studio, see the entire graph, its health, and the exact
assembled prompt — without editing anything.

### Phase 2 — Prose editing with version history ("fine-tune what's written")

The heart of the tool. Editing is restricted to **human-readable prose only**.

- **`prompt_versions` table** — polymorphic: `(entity_type, entity_id, field,
  version, body, note, author, created_at, trace_id?)`. `entity_type ∈ {agent,
  skill, worker}`, `field` distinguishes `system_prompt` vs `extraction_prompt`
  on a worker. `trace_id` nullable now — leaves the door open for Phase 4
  outcome-correlation; cheap to add, expensive to retrofit.
- Make the prose panels editable (agent/skill/worker). **Saving creates a new
  version**; the prior text becomes history. The version timeline *is* the safety
  net — editing a live responder's prompt is always one revert away (this
  supersedes a plain draft/commit).
- **Diff any two versions** (human-readable text diff, rendered). Revert =
  restore a snapshot as a new version.
- **"Why I changed this" note** per version (free text — *what worked / what
  didn't*; outcome links land in Phase 4).
- **Live re-compose**: after an edit, the Phase-1 composed-prompt preview updates
  so you see the new assembled result immediately.

*Deliverable:* fine-tune any prompt — agent, skill, or worker — with full
history, diffs, and revert, seeing the composed result update live.

### Phase 3 — Structure editing ("rewire the graph")

- Edge-level edits on the canvas: attach/detach a skill, add/remove a delegate,
  swap a model, adjust params (temperature / max_tokens / max_iterations).
- Every structural edit re-runs `checkSystemIntegrity` → nodes relight; dangerous
  wiring (e.g. `run_terminal` onto the responder) warns inline — the drift-test
  rules, now interactive.
- **Fan-out warnings**: detaching/editing a shared skill warns "this is on N
  agents."
- **Diff-vs-manifest + "reset to canonical default"** per node — the manifest
  payoff: see how far a node has drifted from factory default, one-click revert.

*Deliverable:* wire the whole graph from one screen, with live linting and
drift-vs-default.

### Phase 4 — Sandbox testing ("does it actually work?") — *parked until stable*

- A **no-persist** multi-turn runner: converse against the *current* (possibly
  uncommitted) agent config **without writing to the brain or conversation
  store**; attach the trace. This no-persist execution mode is the only piece
  with no existing primitive — it's the real engineering problem and is
  deliberately last.
- Bridge to Phase 2: a sandbox run stamps the prompt `version` that produced it,
  closing the "what worked" loop.
- Builds on the existing one-shot `AgentChatTestButton` + `traces`.

---

## Resolved decisions

1. **Placement** — top-level **`/studio`** route + nav entry. Coexists with the
   settings pages.
2. **Versioning** — free-text **"what worked / what didn't" note ships in Phase 2**;
   `trace_id` reserved for the Phase 4 sandbox to close the outcome loop later.
3. **Prose scope** — **every human-written field that instructs an AI**, per the
   registry above (agent/skill/worker prompts + the vision/document extraction
   prompts; persona notes as a structured sibling). Codified as a declarative
   registry in Phase 0 so the set is provable and self-extending.
