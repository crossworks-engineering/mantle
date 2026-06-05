# Tools & Skills — capability vs. teaching, as one source of truth

> **Status: COMPLETE — P0–P5 SHIPPED** (2026-06-05). The full reshape is live:
> substrate (P0), the behavior-identical skill-arm collapse (P1), the Tools-manager
> + Studio group nodes (P2), the god-grant break-up (P3 — runtime group expansion +
> re-expression), the dead-column drop (P4), and the durability + agent-editor pass
> (P5 — group-native self-heal + groups-first editor). Tools are capability (direct
> + groups); skills are pure teaching; every grant is a visible edge. Companion to
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

**Removed (P4):** the `skills.tool_slugs` column and the skill arm of
`effectiveToolSlugs` — skills carry no tools anywhere. (Heartbeat control tools are
granted directly by the fire path, so nothing was lost.)

### New effective-tools resolution

```
effectiveToolSlugs(agent) =
    agent.tool_slugs                              // direct grants / escape hatch
  ∪ expand(agent.tool_group_slugs → group.tool_slugs)   // bundles
```

There is no skill arm (removed in P4 — skills are pure teaching).
`agent.tool_slugs` is retained deliberately as (a) the migration cushion — Saskia
kept her flat grant on day one — and (b) the escape hatch for one-off grants that
don't justify a group (e.g. a specialist's lone `web_search`, the persona's
`page_delete`).

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
| `pages` | `PAGE_TOOLS` | authoring subset (no `page_delete`) — decision 3; delete rides the escape hatch where intended |
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

### Phase 0 — Introduce the substrate (additive, dormant) — ✅ SHIPPED
- ✅ Migration `0080_tool_groups`: `tool_groups` table + `agents.tool_group_slugs`
  (default `{}`). Drizzle schema: `packages/db/src/schema/tool-groups.ts`.
- ✅ Manifest: `MANIFEST_TOOL_GROUPS` (19 groups mirroring the `*_TOOLS` clusters)
  + `KNOWN_TOOL_GROUP_SLUGS` + `ManifestAgent.toolGroupSlugs?`. `applyManifest`
  seeds group rows (gap-fill/overwrite, like skills) and wires the agent grant —
  every agent's grant is `[]` today, so the system is unchanged at runtime.
- ✅ Drift-test (`manifest.test.ts`): groups bundle only known tools, unique +
  non-empty; agents reference only known groups. Integrity (`integrity.ts`):
  `group-tools` (every group seeded + tools resolve) + `dangling-groups` (agent
  grants resolve). 20 tests green; no agent uses groups → all checks green.
- The runtime `effectiveToolSlugs` is **untouched** here — expanding granted
  groups into the effective set is the Phase 3 step.

### Phase 1 — Collapse the skill arm (behavior-identical) — ✅ SHIPPED
- ✅ Migration `0081_collapse_skill_tools`: for the three agent-capability skills
  (`page_editing`, `rich_writing`, `table_authoring`), UNION each one's tools onto
  every attached agent's `tool_slugs`, then empty those skills' `tool_slugs`.
  Scoped to those three slugs only.
- ✅ Manifest: those skills now carry `toolSlugs: []` (drift-test enforces *every*
  manifest skill is tool-free); the agents that relied on them list the tools
  directly — the `pages` agent gains the full page set, and the persona keeps
  `page_delete` via a new `extraToolSlugs` escape hatch (decision 1). Onboarding
  grants the fresh persona `page_delete` too, so new installs match.
- **`effectiveToolSlugs` is deliberately UNCHANGED.** The original plan said
  "drop the skill arm," but the same union is used by heartbeats
  ([`heartbeats/fire.ts`](../packages/heartbeats/src/fire.ts)) to confer a
  heartbeat's bound-skill tools (e.g. `profile_interview`). Ripping it out would
  break those. Instead the *agent* skills are drained (so they add nothing to the
  union) while *heartbeat* skills keep theirs — a separate mechanism. The
  invariant "agent/manifest skills are pure teaching" is enforced at the manifest
  (drift-test), not by deleting the union.
- **Net effect: identical effective sets** — verified on dev by diffing every
  agent's `agent.tool_slugs ∪ attached-skill tools` before vs. after (zero diff).
  Skills are now pure teaching prose.

### Phase 2 — Tools manager + Studio nodes ("no hidden tool grants") — ✅ SHIPPED
- ✅ Tool-group CRUD: `lib/tool-groups.ts` + `app/api/tool-groups/[…]` + a
  dedicated **`/settings/tool-groups`** page (create bundle, pick member tools via
  the shared `ToolPicker`, enable/disable, slug immutable). Delete strips the slug
  from every granting agent. Each group shows a "granted to N agents" fan-out
  badge. (Deviation from the original sketch: a sibling page rather than folding
  into the 510-line `/settings/tools` client — cleaner + lower-risk, and groups
  are a distinct concept. A nav entry sits right under Tools.)
- ✅ Studio graph (`lib/studio/graph.ts` + `studio-view.tsx` + `studio-canvas.tsx`):
  added a `group` node kind + `agent → group` grant edges (violet), a read-only
  `GroupInspector` (members + fan-out + link to the manager), dangling-group
  issues on agent nodes, and the skill node sublabel now reads **"teaching"**
  instead of a (now-always-zero) tool count. Group nodes appear in an agent's
  subgraph only when granted — so today (no grants) the canvas is unchanged; it
  lights up in P3.
- *Scope note:* individual per-tool nodes (`agent → tool`) were **not** added —
  68 tool nodes per agent would bury the graph. Direct grants stay summarised as
  the agent's tool count; groups are the visible unit. The agent inspector already
  lists the count.

### Phase 3 — Break up the god-grant — ✅ SHIPPED
- ✅ **Runtime (P3a):** `effectiveToolSlugs` gained a third arm — granted-group
  tools — resolved via `resolveAgentToolGroups` at all four call sites (web
  assistant, agent process, heartbeats, delegation). Dormant until grants exist.
- ✅ **Re-expression (P3b):** the shared `deriveGroupGrants(full)` helper greedily
  grants every fully-covered tool group and keeps the residual as direct
  `tool_slugs`. Invariant (drift-tested): `residual ∪ ⋃(group tools) === full`, so
  the effective set is unchanged. Wired into the **seeder** (`applyManifest` seeds
  agents decomposed) and **onboarding** (fresh persona seeded decomposed), so a
  fresh install is already broken up and a `seed:*` overwrite preserves it.
- ✅ **Existing brains:** `seed:reexpress-tools` (idempotent) retrofits a
  pre-P3 brain. Applied to dev — Saskia went **70 flat tools → 26 direct + 11
  groups**; every agent verified behavior-identical by diffing its full effective
  set (direct ∪ skill ∪ group tools) before vs. after (zero diff).
- *Residuals are legitimate:* a group is granted only when the agent holds **all**
  its tools, so an incomplete cluster stays direct, alongside true one-offs
  (`page_delete`, `secret_create`, …). Operators refine further in the Studio /
  Tools-manager UIs (P2).

### Phase 4 — Drop the dead column — ✅ SHIPPED
- ✅ Migration `0082_drop_skills_tool_slugs`: `ALTER TABLE skills DROP COLUMN
  tool_slugs`. The gate was clear — the only remaining user was the heartbeat fire
  path, and the sole heartbeat skill (`profile_interview`) carried only
  `heartbeat_update_state` / `heartbeat_complete`, which `fire.ts` already grants
  unconditionally via `HEARTBEAT_CONTROL_TOOLS`. So the column conferred nothing.
- ✅ Cleanup: `effectiveToolSlugs` is now `(agentToolSlugs, groupToolSlugs)` — the
  skill arm is gone entirely; all four callers updated. `toolSlugs` removed from
  the skills schema, both runtime/web skill types, the CRUD lib + API + settings
  UI (no more ToolPicker on skills), the manifest + seeder, integrity (the
  `skill-tools` check is gone), the Studio skill inspector, and the heartbeat seed.
- Verified on dev: column dropped, agent effective sets unchanged (zero diff),
  skills still load. 105 tests green.

### Phase 5 — Make it durable + the editor — ✅ SHIPPED
Two surfaces still spoke the pre-group language, so the decomposition didn't
*stick* and the agent editor told the old story.
- ✅ **Group/auto-grant alignment:** the `contacts` and `lifelog` groups are now
  the no-delete subsets (= `CONTACT`/`LIFELOG_AUTO_GRANT_SLUGS`), matching the
  pages/tables authoring-subset pattern (decision 3). `*_delete` rides the escape
  hatch. This lets an auto-granted conversational agent qualify for the *whole*
  group instead of carrying ~9 tools flat forever.
- ✅ **Group-native self-heal:** `ensureCoreToolsOnConversationalAgents` (runs at
  agent boot) is now coverage-aware — it skips any core tool already conferred by
  a granted group, so it stops re-flattening the decomposition on every restart.
  `seed:tool-groups` now syncs group rows to the manifest (overwrite) so existing
  brains pick up the redefinitions.
- ✅ **Agent editor (`/settings/agents`):** a **Tool groups** picker is now the
  primary capability control; the individual-tool list is demoted to a **Direct
  tools · advanced** escape hatch; and a read-only **Effective tools** readout
  shows `direct ∪ group tools` so the operator sees the agent's true capability,
  not just the residual. The editor + API + `updateAgent` round-trip
  `tool_group_slugs`.
- Verified on dev (reexpress → group-sync ordering keeps `*_delete` as residual):
  effective sets identical (zero diff); Saskia's residual **37 → 17** (all
  legitimate). 10 drift tests green.
- ✅ **Specialist routing:** the generalist persona no longer holds page (or table)
  authoring tools — `ASSISTANT_TOOL_DENY` now excludes all `page_*`/`table_*` from
  `DEFAULT_ASSISTANT`, so document/grid work is **forced to delegate** to the Pages
  / Ledger specialists (holding the tools biased the model into doing it inline).
  The persona keeps `page_share`/`page_unshare` (via the core auto-grant), reads
  page content through the brain, and reaches the specialists via `invoke_agent`.
  Applied to the manifest (fresh installs) + dev's generalist personas.

---

**The end state.** A tool reaches an agent exactly one way that's always visible:
`agent.tool_slugs` (direct/escape-hatch) ∪ the tools of its granted `tool_groups`.
Skills are pure teaching prose. "Why can this agent do X?" has one answer — and the
agent editor, the Tools manager, and the Studio graph all draw it the same way.

## Integrity / manifest impact (implemented through P5)

- `integrity.ts`: the old "skill bundles a tool with no enabled row" check is gone
  (skills carry no tools). Added `group-tools` (every manifest group is seeded and
  its member tools resolve) + `dangling-groups` (every agent's granted groups
  resolve to an enabled group). `dangling-tools` + `dangling-skills` stay.
- `manifest.test.ts`: validates every group's tools ∈ `KNOWN_TOOL_SLUGS` (unique,
  non-empty), every agent's groups ∈ `KNOWN_TOOL_GROUP_SLUGS`, and the
  `deriveGroupGrants` round-trip (`residual ∪ group-tools === full`) for every
  manifest agent. The persona-grant test asserts page/table authoring +
  `run_terminal` stay out while `invoke_agent` stays in.
- Studio `graph.ts`: `StudioSkillDetail` no longer carries tools; added
  `StudioToolGroupDetail` + group nodes + `agent→group` edges.

## Decision log

1. ~~`page_delete` preserved on the persona (P1).~~ **SUPERSEDED (P5):** the persona
   delegates page work to the Pages specialist and holds **no** `page_*` authoring
   tools — `ASSISTANT_TOOL_DENY` excludes all `page_*`/`table_*` from
   `DEFAULT_ASSISTANT`. Sharing (`page_share`/`page_unshare`) stays via the core
   auto-grant; page content is read through the brain.
2. ~~`agent.tool_slugs` kept long-term as the escape hatch (P1 decision 2).~~
   **SUPERSEDED (P6, planned):** an editable direct-tool grant alongside groups
   divides the source of truth. P6 makes tool groups the SOLE grant and drops
   `agent.tool_slugs` + the editor's "Direct tools" section. See the handover.
3. **Authoring-subset groups** (confirmed + extended): `pages`/`tables` — and, in
   P6, `contacts`/`lifelog` — groups exclude the destructive `*_delete`; deletes
   live in deliberate `*-admin` groups, granted on purpose, never auto.

## Phase 6 — groups as the sole tool-grant (PLANNED — not started)

**Goal:** tool groups become the *only* way to grant a tool. `agent.tool_slugs`
and the agent editor's "Direct tools · advanced" section are removed; skills are
teaching, groups are capability — one source of truth, end to end.

**Status:** fully designed, **not implemented**. The partial taxonomy groundwork
was reverted so `main` stays clean at P0–P5. The complete design — the final group
taxonomy, the agent→group mapping (approach A: coarse groups, specialists expand),
every edge discovered (page-share / recall splits, `*-admin` delete groups,
heartbeat + `read_result` as runtime affordances), the file-by-file change plan,
and the verification approach — is in
**[docs/handover-tools-skills-p6.md](handover-tools-skills-p6.md)**.
