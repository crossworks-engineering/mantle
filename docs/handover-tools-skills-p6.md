# Handover — Tools & Skills, Phase 6 (groups as the sole tool-grant)

> Continuation brief for a fresh context. Companion to
> [docs/tools-and-skills.md](tools-and-skills.md) (the canonical record).
> Written 2026-06-05 after P0–P5 shipped + pushed.

## TL;DR

P0–P5 shipped. **P6a is now shipped + merged to `main`** (`0.19.27`): every
manifest agent is authored as a pure **tool-group list** (`toolSlugs: []`), the
group taxonomy is complete (every grantable builtin lives in ≥1 group), the
heartbeat-responder tools are a runtime affordance (not a stored grant), and the
boot self-heal grants the core floor as **groups**. The dev brain was re-granted
(5 specialists: benign `memory-core`/`files` expansion only; both operator
personas onto the generalist group list). `agents.tool_slugs` is **kept but
emptied** — the runtime still reads it, so nothing breaks.

**P6b is what remains** (this handover's "P6b" section): drop the
`agents.tool_slugs` column (mig `0083`), make `effectiveToolSlugs` group-only,
strip the editor's "Direct tools · advanced" section, and remove the now-dead
`deriveGroupGrants`/`DEFAULT_ASSISTANT`/`resolveManifestToolSlugs` helpers +
schema/type fields. Goal unchanged: **tool groups the SOLE grant mechanism.**

> **P6b precondition (dev only):** before the column drop, confirm the dev
> operator personas (`telegram-default`, `apostle-paul`) hold their full
> capability via groups — P6a already re-granted them the generalist list, so
> their flat `tool_slugs` is safe to drop. `apostle-paul` intentionally lost
> `run_terminal`/`peer_*`/`contact_delete`; re-add the `terminal`/`federation`
> groups if it needs them.

The user's framing (verbatim intent): *"having 'Direct tools · advanced' in agents
divides the source of truth for tool configuration — you could just create a new
group to satisfy loose ends, or properly divide your tools up."* They are right;
P6 is the fix.

## Current architecture (what's already true)

- **Tools** — the `tools` registry (builtins seeded on boot; `/settings/tools`).
- **Tool groups** — `tool_groups` table (mig `0080`), `agents.tool_group_slugs[]`.
  19 default groups in `MANIFEST_TOOL_GROUPS` (`apps/web/lib/system-manifest/manifest.ts`).
  Manager UI at `/settings/tool-groups`; group nodes in `/studio`.
- **Skills** — pure teaching prose. `skills.tool_slugs` **dropped** (mig `0082`).
- **Runtime** — `effectiveToolSlugs(agentToolSlugs, groupToolSlugs)` in
  `packages/agent-runtime/src/skills.ts`; `resolveAgentToolGroups(ownerId, slugs)`
  flattens granted groups. Four call sites: `apps/web/lib/assistant.ts` (web),
  `apps/agent/src/main.ts` (Telegram/responder), `packages/heartbeats/src/fire.ts`,
  `packages/agent-runtime/src/invoke-agent.ts` (delegation).
- **Decomposition** — `deriveGroupGrants(full)` in `manifest.ts`: greedily grants
  every *fully-contained* group, residual stays direct `tool_slugs`. Invariant
  (drift-tested): `residual ∪ ⋃(group tools) === full`.
- **Seeding** — `applyManifest` (`apps/web/lib/system-manifest/seed.ts`) seeds groups
  + agents decomposed; onboarding (`apps/web/lib/onboarding-provision.ts`) seeds the
  persona decomposed. CLI: `pnpm -C apps/web seed:tool-groups` (sync group rows,
  overwrite) and `seed:reexpress-tools` (retrofit an existing brain's agents).
- **Migrations applied on dev**: `0080` (groups), `0081` (collapse skill tools →
  agent grants), `0082` (drop `skills.tool_slugs`).
- **P5 routing** — `ASSISTANT_TOOL_DENY` (`packages/tools/src/builtins.ts`) excludes
  all `page_*`/`table_*` so the generalist persona **delegates** document/grid work
  to the Pages / Ledger specialists. Persona keeps `page_share`/`page_unshare` via
  the core auto-grant; reads page content via the brain.

### The self-heal (important — it re-flattens grants)

`ensureCoreToolsOnConversationalAgents` (`apps/agent/src/main.ts`, runs at agent
boot) appends `CORE_AUTO_GRANT_SLUGS` to a conversational agent's `tool_slugs`. As
of P5 it is **coverage-aware** (skips tools already conferred by a granted group),
so it no longer duplicates group tools. **P6 must make it grant a GROUP, not flat
tools** (or it has nothing to write once `tool_slugs` is gone). NB the **running
dev agent process** only picks up self-heal changes on **restart** — after any dev
re-grant, a stale process can re-flatten until restarted.

## P6 goal & the user's decisions

- **Goal:** tool groups are the *only* grant mechanism. Drop `agent.tool_slugs`
  (mig `0083`) and the editor's "Direct tools · advanced" section. `effectiveToolSlugs`
  becomes `expand(groups)` (+ runtime affordances, below).
- **Decision (this session): approach A — coarse groups, specialists expand.**
  Rather than add many fine-grained subset groups, grant specialists the *full*
  coarse groups (`files`, `memory-core`). Consequence: minor, benign capability
  gains for specialists (e.g. the Pages agent can `file_create`, read entity-graph
  tools). **Not behavior-identical for specialists** — that is accepted.
- **Reversed earlier decisions:** (1) persona keeps `page_delete` → SUPERSEDED in
  P5 (persona delegates page work). (2) keep `agent.tool_slugs` escape hatch →
  SUPERSEDED by P6 (this work).

## Why it's bigger than "drop a column"

Groups grant on **full containment** (an agent gets a group only if it holds every
tool in it — keeps it behavior-safe). Specialists hold **partial** sets (e.g. Pages
has read-only file tools + `search_nodes`/`node_read`, not the full `files`/`memory-core`
groups), so those groups don't auto-grant and the tools stay residual. To zero the
residual (the precondition for dropping the column) you must **author the manifest
agents as explicit group lists** (they stop being flat tool-lists) and accept the
specialist expansion. That cascades into onboarding, seed, the 4 runtime callers,
the self-heal, the editor, Studio, ~6 test files, and the migration. ~25–30 files.

## The final taxonomy (design)

Keep the existing 19 groups. **Change/add:**

| Group | Tools | Notes |
|---|---|---|
| `recall` *(redefine)* | `recall_window` | was `{find_window, recall_window}`; split so the persona can hold recall without `find_window` (which is denied/delegated to Remy) |
| `recall-search` *(new)* | `find_window` | Remy only |
| `page-share` *(new)* | `page_share`, `page_unshare` | lets the persona share without the authoring group. Recommend **removing** share/unshare from the `pages` authoring group so there's no overlap, and granting `pages` + `page-share` to the Pages agent |
| `secrets` *(new)* | `secret_create` | persona |
| `ingest` *(new)* | `process_extraction` | persona |
| `page-admin` *(new)* | `page_delete`, `page_update` | Pages agent |
| `table-admin` *(new)* | `table_delete` | not granted by default |
| `contacts-admin` *(new)* | `contact_delete` | deliberate-only; not on the persona |
| `lifelog-admin` *(new)* | `lifelog_delete` | deliberate-only; not on the persona |

These cover the orphan tools surfaced by the audit (`secret_create`,
`process_extraction`, `page_update`, `page_delete`, `table_delete`, `contact_delete`,
`lifelog_delete`, plus `recall_window`/`find_window` and `page_share`/`page_unshare`).
After this, **every grantable builtin lives in ≥1 group.**

### Runtime affordances (NOT groups, NOT stored grants)

These are injected by the loop based on context — keep them out of stored grants:
- `read_result` — the tool-loop should always offer it (verify in
  `packages/agent-runtime/src/tool-loop.ts`). The `tool-results` group can be retired
  or kept harmless.
- `heartbeat_*` (`heartbeat_complete/snooze/update_state/list/fire`) — `fire.ts`
  already injects `HEARTBEAT_CONTROL_TOOLS` for heartbeat turns. For the **responder
  awareness** path (acting on an active heartbeat during a normal turn), `assistant.ts`
  + `main.ts` should **inject** these when `hasActiveHeartbeatsOnSurface` is true,
  rather than relying on a stored grant + the current filter-out hygiene. Then the
  `seed-get-to-know-user` `ensureHeartbeatToolsOnAgent` flat grant is removed.
  *(Alternative if you want lower risk: make a `heartbeat-control` group and grant it
  via the self-heal, keeping the per-turn filter. Less pure but simpler.)*

## The agent → group mapping (approach A)

Author each `MANIFEST_AGENTS` entry with explicit `toolGroupSlugs` (drop the flat
`toolSlugs`/`extraToolSlugs`/`DEFAULT_ASSISTANT` sentinel for grants):

- **assistant (persona):** `memory-core, files, notes, events, todos, contacts,
  lifelog, recall, email, persona, media-workers, delegation, messaging, secrets,
  ingest, tool-results, page-share`
  (NOT `pages`/`page-admin`/`tables` — delegated; NOT the `*-admin` deletes; NOT
  `terminal`/`research`/`federation`/`recall-search`.)
- **pages:** `pages, page-admin, page-share, files, memory-core`
- **tables (Ledger):** `tables, files, memory-core`
- **remy:** `recall, recall-search, memory-core`
- **researcher:** `research, memory-core`
- **coder:** `terminal, files, memory-core`

Verify each agent's effective set (`⋃ group tools`) ⊇ its current effective set
(the expansions are the only additions). The persona intentionally **loses**
`contact_delete`/`lifelog_delete` (now `*-admin`, deliberate-only) — flag that as
the one capability removal.

## File-by-file plan

Suggested two commits: **P6a** (taxonomy + agents-as-groups + self-heal + verify;
keep `tool_slugs` column present but empty so runtime still works) → **P6b** (drop
the column + remove the editor "Direct tools" section + dead code).

**P6a — ✅ DONE** (commit `feat(tools): P6a …`, `0.19.27`). Resolved micro-decisions:
(1) `page-share`/`page-admin` carry share + delete/overwrite; `pages` group trimmed
to authoring-only (no overlap). (2) heartbeat tools = **runtime-inject** (purer):
`assistant.ts`/`main.ts` inject `HEARTBEAT_RESPONDER_TOOLS` when
`hasActiveHeartbeatsOnSurface`; the seed flat-grant is gone. (3)
`DEFAULT_ASSISTANT_TOOL_SLUGS`/`ASSISTANT_TOOL_DENY` **kept** (vestigial) — P6b
cleanup. The self-heal grants `CORE_AUTO_GRANT_GROUP_SLUGS`
(`persona,todos,contacts,lifelog,notes,email,page-share`), coverage-aware.

Steps that were executed:
1. `manifest.ts`: add the new groups + redefine `recall`; author all 6 agents with
   explicit `toolGroupSlugs` and `toolSlugs: []`. Decide `pages` group share/unshare
   overlap (recommend remove from `pages`, keep in `page-share`).
2. `seed.ts` `upsertAgent`: set `tool_group_slugs = def.toolGroupSlugs`, `tool_slugs = []`;
   stop using `deriveGroupGrants` for manifest agents (they're explicit now).
3. `onboarding-provision.ts`: seed the persona from the manifest persona's
   `toolGroupSlugs` (not `DEFAULT_ASSISTANT`).
4. Self-heal (`main.ts`): grant the persona's core **groups** (or a `heartbeat-control`
   group) instead of flat tools; reclassify `heartbeat_*` per the affordances note.
5. `manifest.test.ts`: assert every agent's `toolGroupSlugs ⊆ KNOWN_TOOL_GROUP_SLUGS`,
   every group's tools ∈ `KNOWN_TOOL_SLUGS`, and (new) that authored agents need no
   residual. Update the persona-grant test for the group world.
6. Dev: re-grant agents their group lists (a small script), clear `tool_slugs`.
   Verify effective sets via the effdump technique (below).

**P6b**
7. Migration `0083_drop_agents_tool_slugs.sql`: `ALTER TABLE agents DROP COLUMN tool_slugs`.
8. Schema/types: remove `toolSlugs` from `agents` schema, `AgentSummary` (lib +
   the client copy in `agents-client.tsx`), `CreateAgentInput`, `updateAgent`.
9. Runtime: `effectiveToolSlugs(groupToolSlugs)` (drop the agent-tools arm); update
   the 4 callers to pass only resolved group tools (+ affordances). Drop the dead
   web `lib/skills.ts` already done; remove `deriveGroupGrants`/`reexpress` if now
   unused (or repurpose).
10. Editor (`agents-client.tsx`): remove the "Direct tools · advanced" fieldset +
    the `availableTools`/`toolSlugs` form state; keep the Tool-groups picker + the
    read-only Effective-tools readout (now = group tools only). Drop `availableTools`
    from `agents/page.tsx`.
11. Studio `graph.ts`: agent `toolCount` from groups, not `tool_slugs`.
12. Tests across packages; typecheck all of `packages/{db,agent-runtime,heartbeats}`
    + `apps/{web,agent}`.

## Verification technique (used throughout P0–P5)

Effective-set diff via a throwaway script under `apps/web/scripts/_xxx.ts`
(run `pnpm -C apps/web exec tsx --env-file-if-exists=./.env.local scripts/_xxx.ts`,
then delete it). Compute each agent's effective set = `tool_slugs ∪ skill-tools(none)
∪ ⋃(granted group tools)`, sorted; snapshot before, apply, snapshot after, `diff`.
For P6 the diff is **not** empty — the specialist expansions + the persona's
`*_delete` removal are intentional. Assert the diff equals exactly those expected
deltas (don't accept surprises). `ALLOWED_USER_ID` is in `apps/web/.env.local`.

## Workflow / environment gotchas

- **Worktree + commit cadence:** work in the worktree; `pnpm version:bump patch`
  before each ff-merge to `main`; commit messages end with the Co-Authored-By
  trailer; push only when asked (the user has been asking). Dev stack runs from
  `~/Projects/mantle` on `main`.
- **Path mixup (watch for this):** in this session the Write/Edit tools wrote to
  absolute `~/Projects/mantle/...` paths (the main checkout) while `git` ran in the
  worktree — commits silently missed files until reconciled. Be consistent about
  which working dir you edit vs. commit in.
- **Migrations:** hand-written SQL + a journal entry in
  `packages/db/migrations/meta/_journal.json` (per-migration `when` strictly
  increasing). Runner: `pnpm -C packages/db migrate` (reads the journal). `0083` is next.
- **Drift test is the gate:** `pnpm exec vitest run system-manifest` from repo root
  (note: run from root, not `-C apps/web`).
- **Prod is a fresh install** — no data migration needed there; onboarding seeds
  agents decomposed. Only dev (the established brain) needs re-grant scripts.
- **Stale `.next` `settings/senders` type error** is pre-existing noise — filter it
  out of `tsc` output (`grep -v settings/senders`).

## Open micro-decisions for P6

1. `page-share` overlap with the `pages` group (recommend: remove share/unshare
   from `pages`, keep only in `page-share`).
2. `heartbeat_*`: runtime-inject (purer) vs `heartbeat-control` group (simpler).
   Recommend runtime-inject to match the "affordance, not config" principle.
3. Whether to retire `DEFAULT_ASSISTANT_TOOL_SLUGS` + `ASSISTANT_TOOL_DENY` once the
   persona is group-authored (they become vestigial; the `default-assistant-tools`
   test depends on them). Recommend: keep for now, note as cleanup.
