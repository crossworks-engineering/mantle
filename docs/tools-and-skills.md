# Tools & Skills — capability vs. teaching, as one source of truth

> **Status: DESIGN** (2026-06-05). Proposed reshape of how agents acquire tools.
> Pins the model + a behavior-safe migration before any code. Companion to
> [docs/agent-studio.md](agent-studio.md) and
> [docs/system-integrity.md](system-integrity.md).

## The problem

Today a tool reaches an agent through **two** independent channels that the
runtime silently unions:

```
effectiveToolSlugs = agent.tool_slugs  ∪  (every attached skill's tool_slugs)
```

— [`effectiveToolSlugs`](../apps/web/lib/skills.ts) (web) and its twin
[`packages/agent-runtime/src/skills.ts`](../packages/agent-runtime/src/skills.ts),
consumed by [`assistant.ts`](../apps/web/lib/assistant.ts) and
[`invoke-agent.ts`](../packages/agent-runtime/src/invoke-agent.ts).

This is a **split-brain**. To answer "why can this agent edit pages?" you check
two places. It directly contradicts Studio's governing principle — *no hidden
prompts, make composition visible*. A concrete leak it produces today: the
`assistant` persona's `rich_writing` skill bundles the full `PAGE_TOOLS`
including `page_delete`, which the assistant deny-set
([`builtins.ts` `ASSISTANT_TOOL_DENY`](../packages/tools/src/builtins.ts))
explicitly tries to withhold — the skill union silently overrides the deny, and
nothing surfaces it.

## The model

Two orthogonal concerns, cleanly separated:

| Concept | Answers | Carries | Granted to |
|---|---|---|---|
| **Tool** | *what an atomic capability is* | a handler (`builtin`/`http`/`shell`) | — (registry atom) |
| **Tool group** | *a named bundle of tools you grant as a unit* | `tool_slugs[]` | agents |
| **Skill** | *how to do something well* | `instructions` (prose only) | agents **+ workers** |

- **Tools** stay as the existing first-class [`tools`](../packages/db/src/schema/tools.ts)
  registry + [`/settings/tools`](../apps/web/app/(app)/settings/tools) manager.
- **Tool groups** are NEW — named bundles (e.g. *Pages toolkit*, *Calendar*,
  *Memory core*) an owner grants to an agent in one move. They are capability-only:
  no instructions, no behaviour.
- **Skills lose `tool_slugs` entirely** and become pure teaching — the prose layer
  Studio already versions. A skill never confers a capability; it only shapes how
  an agent uses the capabilities it already holds.
- **Workers are skills-only.** Workers (extractor/summarizer/reflector/document/…)
  may receive teaching skills but never tool grants — they're single-purpose LLM
  calls and carry no `tool_slugs` today.

### Governing principle (extends Studio's)

> **No hidden tool grants.** Every capability an agent holds is a visible edge:
> `agent → tool` (direct) or `agent → group → tools` (bundle). The Studio graph
> becomes a complete answer to "what can this agent do, and why."

## What changes vs. what's reused

**Reused as-is:** the `tools` table, `/settings/tools`, `agent.tool_slugs` (now the
*direct/escape-hatch* grant), the manifest spine, `checkSystemIntegrity`, the
Studio graph read model.

**New:**
- `tool_groups` table — `{ id, ownerId, slug, name, description, toolSlugs[],
  enabled, createdAt, updatedAt }`. Owner-scoped, mirrors the `skills`/`tools`
  shape. (No nesting: a group is a flat list of tool slugs; groups don't contain
  groups.)
- `agents.tool_group_slugs text[]` — the bundles granted to this agent.
- Manifest: `MANIFEST_TOOL_GROUPS` (seeded defaults); skills drop `toolSlugs`;
  agents gain `toolGroupSlugs`.

**Removed (end state):** `skills.tool_slugs` column; the skill arm of the
`effectiveToolSlugs` union.

### New effective-tools resolution

```
effectiveToolSlugs(agent) =
    agent.tool_slugs                              // direct grants / escape hatch
  ∪ expand(agent.tool_group_slugs → group.tool_slugs)   // bundles
```

The skill arm is gone. `agent.tool_slugs` is retained deliberately as (a) the
migration cushion — Saskia keeps her flat 68 here on day one — and (b) the
escape hatch for one-off grants that don't justify a group (e.g. a specialist's
lone `web_search`).

### Default groups already exist in code

The seed taxonomy is pre-drawn: the `*_TOOLS` arrays in
[`packages/tools/src`](../packages/tools/src) ARE the bundles. Each becomes a
`MANIFEST_TOOL_GROUPS` entry:

| Group slug | Source array | Notes |
|---|---|---|
| `memory-core` | the loose head of `BUILTIN_TOOLS` | `search_nodes`, `search_chunks`, `node_read`, `tree_list`, entity/graph reads — the read primitives every responder needs |
| `files` | `file_*` + `folder_*` | source-file read/list/get |
| `notes` | `NOTE_TOOLS` | |
| `events` | `EVENT_TOOLS` | calendar CRUD |
| `todos` | `TODO_TOOLS` | |
| `pages` | `PAGE_TOOLS` | authoring subset vs. full (incl. `page_delete`) decided per-grant — see open question |
| `tables` | `TABLE_TOOLS` | |
| `contacts` | `CONTACT_TOOLS` | the email gate ([contacts.md](contacts.md)) |
| `lifelog` | `LIFELOG_TOOLS` | identity |
| `recall` | `RECALL_TOOLS` | `find_window`, `recall_window` |
| `research` | `RESEARCH_TOOLS` | `web_search` |
| `email` | `EMAIL_TOOLS` | send/list/get |
| `persona` | `PERSONA_TOOLS` | `update_persona` |
| `media-workers` | `WORKER_DELEGATION_TOOLS` | TTS/vision/summarize/image |
| `delegation` | `invoke_agent` | |
| `terminal` | `TERMINAL_TOOLS` | `run_terminal` — coder only |
| `tool-results` | `TOOL_RESULT_TOOLS` | `read_result` — always offered by the loop anyway |
| `federation` | `PEER_TOOLS` | opt-in |

`DEFAULT_ASSISTANT_TOOL_SLUGS` is then re-expressible as a set of these groups
(everything minus terminal/federation/the specialist-delegated bits) — but that
re-expression is Phase 3, not day one.

## Migration — behavior-safe, phased

Each phase keeps `checkSystemIntegrity` green and the effective tool set
unchanged unless explicitly noted. The runtime already unions, which is what
makes the cutover a no-op.

### Phase 0 — Introduce the substrate (additive, dormant)
- Migration: add `tool_groups` table + `agents.tool_group_slugs` (default `{}`).
- Manifest: add `MANIFEST_TOOL_GROUPS` from the `*_TOOLS` arrays; `applyManifest`
  seeds group rows (gap-fill, like skills). Nothing references them yet.
- Drift-test + integrity gain group awareness (dangling group ref; group→tool
  resolution) but no agent uses groups → all green.

### Phase 1 — Collapse the skill arm (behavior-identical)
- For each tool-bearing skill (`page_editing`, `rich_writing`, `table_authoring`),
  push its `tool_slugs` onto every attached agent's `tool_slugs` (data migration),
  then set `skill.tool_slugs = []`.
- Flip `effectiveToolSlugs` (both twins) to drop the skill arm.
- Manifest: skills lose `toolSlugs`; the agents that relied on them get those
  tools listed directly.
- **Net effect: identical effective sets.** The persona's `page_delete` — today an
  implicit grant via `rich_writing` — is *preserved* as an explicit direct
  `tool_slugs` entry (decision 1): same capability, now visible instead of hidden.
  Skills are now pure prose.

### Phase 2 — Tools manager + Studio nodes ("no hidden tool grants")
- `/settings/tools`: add tool-group CRUD (create bundle, pick member tools,
  enable/disable). Group fan-out badge ("granted to N agents"), mirroring skills.
- Studio graph ([`graph.ts`](../apps/web/lib/studio/graph.ts)): add `tool` and
  `group` node kinds + `agent → group` / `agent → tool` grant edges; skill node
  sublabel stops showing a tool count (skills are tool-free) and reads as teaching.
- Now every grant is a visible edge — the principle is realized in the UI.

### Phase 3 — Break up the god-grant
- Re-express the persona's flat 68 as group grants (`memory-core`, `notes`,
  `events`, `todos`, `pages`, `contacts`, `lifelog`, `email`, `persona`,
  `media-workers`, `delegation`, …), draining `tool_slugs` toward empty.
- Specialists likewise move to groups; `tool_slugs` keeps only true one-offs.
- This is the "slowly break up" the design is built to enable — incremental,
  one agent at a time, each diffable against the manifest in Studio.

### Phase 4 — Drop the dead column
- Once no skill carries tools and the column is unread, drop `skills.tool_slugs`.

## Integrity / manifest impact

- `integrity.ts`: drop the "bundled tool has no enabled row" skill check; add a
  group-resolution check (every `agent.tool_group_slugs` resolves to an enabled
  group; every group member resolves to an enabled tool). `dangling-tools` stays.
- `manifest.test.ts`: extend `KNOWN_TOOL_SLUGS` validation to group membership;
  assert every agent's referenced groups exist in `MANIFEST_TOOL_GROUPS`.
- Studio `graph.ts`: skill `toolSlugs` → removed from `StudioSkillDetail`; new
  `StudioToolGroupDetail` + node/edge emission.

## Resolved decisions (2026-06-05)

1. **`page_delete` on the persona — preserved.** Saskia keeps it; Phase 1 makes
   the grant explicit (a direct `tool_slugs` entry) rather than dropping it. The
   capability is unchanged — it just stops being a hidden side-effect of
   `rich_writing` and becomes a visible grant.
2. **`agent.tool_slugs` is kept long-term** as the one-off escape hatch. Grants
   that don't justify a whole group (a specialist's lone `web_search`, the
   persona's preserved `page_delete`) live here. Groups never shrink to a single
   tool just for purity's sake.
3. **One `pages` group**, scoped to the authoring subset (no `page_delete`). Where
   delete is intended — the persona, per decision 1 — it's a direct `tool_slugs`
   grant via the escape hatch, *not* a member of the group. This keeps the group
   clean and reusable: granting `pages` to the Pages specialist does **not**
   silently confer delete (preserving its current behavior).
