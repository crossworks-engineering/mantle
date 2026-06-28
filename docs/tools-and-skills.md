# Tools & Skills — capability vs. teaching, as one source of truth

> **Status: COMPLETE — P0–P6 SHIPPED.** Tool groups are the **sole** tool-grant:
> an agent's capability is exactly the union of its granted groups' tools.
> `agents.tool_slugs` was dropped (migration `0083`); skills are pure teaching;
> every grant is a visible edge. The phased journey — P0 substrate → P1 skill-arm
> collapse → P2 manager/Studio → P3 god-grant break-up → P4 drop `skills.tool_slugs`
> → P5 durability/editor → **P6 groups-as-the-sole-grant + audit follow-up** — is
> recorded below.
>
> ⚠️ **Read the P0–P5 sections as history.** They describe the design mid-journey
> and still reference the direct / `tool_slugs` "escape hatch" that **P6 removed**.
> The authoritative current model is the **Phase 6** section near the end of this
> doc; where the early sections and Phase 6 disagree, Phase 6 wins. Companion to
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

**Reused as-is:** the `tools` table, `/settings/tools`, the manifest spine,
`checkSystemIntegrity`, the Studio graph read model. (`agent.tool_slugs` was
reused as the direct/escape-hatch grant *through P5*, then **dropped in P6** —
groups are now the sole grant.)

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

### Effective-tools resolution

> **Final (P6).** Groups are the sole grant:
> ```
> effectiveToolSlugs(agent) = expand(agent.tool_group_slugs → group.tool_slugs)
>                             (+ heartbeat_* injected per-turn when a heartbeat is active)
> ```
> No skill arm (removed P4) and no direct `agent.tool_slugs` arm (the column was
> dropped in P6, migration `0083`).

Through P3–P5 the formula *additionally* unioned `agent.tool_slugs` as a migration
cushion + one-off escape hatch (Saskia kept her flat grant on day one; the persona
carried `page_delete`). **P6 removed that arm** so the source of truth is
undivided — the escape-hatch cases became dedicated groups (e.g. `page-admin`,
`recall-search`, `research`). See the **Phase 6** section below.

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
| `tasks` | `TASK_TOOLS` | |
| `pages` | `PAGE_TOOLS` | authoring subset (no `page_delete`) — decision 3; delete rides the escape hatch where intended |
| `tables` | `TABLE_TOOLS` | |
| `contacts` | `CONTACT_TOOLS` | the email gate ([contacts.md](contacts.md)) |
| `journal` | `JOURNAL_TOOLS` | identity |
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
- ✅ **Group/auto-grant alignment:** the `contacts` and `journal` groups are now
  the no-delete subsets (= `CONTACT`/`JOURNAL_AUTO_GRANT_SLUGS`), matching the
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
   P6, `contacts`/`journal` — groups exclude the destructive `*_delete`; deletes
   live in deliberate `*-admin` groups, granted on purpose, never auto.

## Phase 6 — groups as the sole tool-grant (✅ SHIPPED)

**Goal (met):** tool groups are the *only* way to grant a tool. `agent.tool_slugs`
and the agent editor's "Direct tools · advanced" section are gone; skills are
teaching, groups are capability — one source of truth, end to end.

The effective set is now simply:

```
effectiveToolSlugs = expand(agent.tool_group_slugs → group.tool_slugs)
                     (+ heartbeat_* injected per-turn when a heartbeat is active)
```

Shipped in two commits (approach A — coarse groups, specialists expand):

- ✅ **P6a** (`0.19.27`): every `MANIFEST_AGENTS` entry authored as an explicit
  `toolGroupSlugs` list (`toolSlugs: []`); taxonomy completed so every grantable
  builtin lives in ≥1 group — `recall` split into `recall`/`recall-search`,
  `pages` trimmed, and `page-admin`/`page-share`/`table-admin`/`contacts-admin`/
  `journal-admin`/`secrets`/`ingest` added. Heartbeat-responder tools became a
  per-turn **affordance** (injected in `assistant.ts`/`main.ts` when
  `hasActiveHeartbeatsOnSurface`), not a stored grant. The boot self-heal
  (`ensureCoreToolsOnConversationalAgents`) grants the core floor as **groups**
  (`CORE_AUTO_GRANT_GROUP_SLUGS`). Onboarding seeds the persona from
  `PERSONA_TOOL_GROUP_SLUGS`. Dev brain re-granted (5 specialists + both operator
  personas); the persona loses `contact_delete`/`journal_delete` (now
  deliberate-only `*-admin`).
- ✅ **P6b** (`0.19.31`): migration `0083` drops `agents.tool_slugs`;
  `effectiveToolSlugs(groupToolSlugs)` is group-only; the 4 runtime callers pass
  only resolved group tools; the editor's "Direct tools · advanced" fieldset +
  the `availableTools` prop are removed (the Tool-groups picker + read-only
  Effective-tools readout remain); the integrity checker + Studio compute the
  effective set from groups; and the dead `deriveGroupGrants` /
  `resolveManifestToolSlugs` / `DEFAULT_ASSISTANT_TOOL_SLUGS` / `ASSISTANT_TOOL_DENY`
  + the reexpress CLI are removed.

- ✅ **P6c** (audit follow-up — [docs/audit-brief-tools-skills.md](audit-brief-tools-skills.md)):
  three fixes from the independent audit.
  - **Floor sufficiency (R5).** `CORE_AUTO_GRANT_GROUP_SLUGS` gained `memory-core`
    + `delegation`. The old 7-group floor conferred neither `search_*` nor
    `invoke_agent`, so a self-healed-only persona (a *new* operator persona, since
    operator personas aren't manifest-seeded) couldn't ground answers and failed
    the integrity persona check ("missing invoke_agent — cannot delegate"). The
    floor is now the functional minimum; the richer generalist groups stay opt-in
    / manifest-seeded so a locked-down responder isn't over-granted. The decision
    logic moved to `apps/agent/src/core-tools.ts` (`computeFloorGroupAdditions`)
    and is unit-tested (`core-tools.test.ts`).
  - **Web heartbeat dispatch (R8).** `apps/web/lib/assistant.ts` now calls
    `registerHeartbeatTools()` at module load (beside `registerAgentInvoker`). The
    web responder runs its tool loop in-process and injects the continuity tools
    when a **web-surface** heartbeat is active, but the handlers live in
    `@mantle/heartbeats` and only enter the registry via that call — without it,
    the model was offered seeded tool rows whose dispatch failed with "builtin
    handler '…' not registered in this process". `tools.test.ts` pins the
    register→dispatchable contract.
  - **Established-brain backfill (R6).** Migration `0084` re-grants the 6 manifest
    agents their group lists **by slug** when `tool_group_slugs` is still `'{}'`
    (post-`0083`, the old `tool_slugs` is gone, so the re-grant can't derive from
    it). No-op on a fresh install (no rows yet) and on dev (already granted);
    restores a brain that ran `0080..0083` without the deleted re-expression
    script. Operator personas (non-manifest) are floored by the boot self-heal.
  - **Integrity surfacing (M1/M2).** The `group-tools` check (extracted to the
    pure, unit-tested `group-checks.ts`) now flags a **disabled manifest group**
    (the runtime + self-heal floor drop it silently — previously the check read
    the row but never its `enabled` flag, and dangling-groups only fires for a
    group an agent grants) and validates **custom (operator-created) groups'**
    member tools resolve, not just the manifest ones. A disabled *custom* group is
    left alone (parking is operator discretion; a disabled granted group is caught
    by dangling-groups).
  - **Housekeeping (N1/N2/N3).** Migration `0085` drops the dead legacy
    `agents.tools` jsonb column (the pre-P6 free-form MCP name array; its CRUD-lib
    + API plumbing went with it). Group descriptions for `pages`/`tables` reworded
    to say block/row/column deletes ARE in the authoring set — only the
    whole-object delete is isolated to `*-admin`. The stray ungrouped `test-tool`
    row was removed from dev, so every enabled tool now lives in ≥1 group.

The original design brief is preserved at
**[docs/handover-tools-skills-p6.md](handover-tools-skills-p6.md)** (historical).
