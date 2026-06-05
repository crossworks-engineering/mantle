# Audit brief — Tools / Tool-groups / Skills separation (P0–P6)

> **Purpose.** This is a handover for an independent audit of the multi-phase
> refactor that separated **tools (capability)** from **skills (teaching)** and
> made **tool groups the sole tool-grant mechanism**. It is written for a fresh
> session whose job is to find **gaps, serious bugs, and flawed thinking** — not
> to re-implement. Be adversarial. Where this brief asserts an invariant, try to
> break it. Canonical record: [docs/tools-and-skills.md](tools-and-skills.md).
> Historical design brief: [docs/handover-tools-skills-p6.md](handover-tools-skills-p6.md).
>
> State at time of writing: all phases shipped to `main`, `v0.19.32`, migrations
> `0080`–`0083` applied on dev. Prod is a fresh install (onboarding seeds the
> new shape). Not yet pushed to origin.

---

## 1. What the refactor set out to do

Before: capability reached an agent through three tangled paths — an agent's
direct `tool_slugs`, the `tool_slugs` of every skill attached to it, and (later)
tool groups. Skills were both teaching *and* capability. The source of truth for
"what can this agent do?" was split.

After (end state):

- **Tools = capability.** A tool reaches an agent **exactly one way**: the agent's
  granted **tool groups**. `agents.tool_group_slugs[]` → union of those groups'
  member tools = the agent's effective tool allowlist.
- **Tool groups = the grant unit.** Named bundles in the `tool_groups` table.
- **Skills = pure teaching.** Prose injected into the system prompt. They carry
  **no tools** at all.
- **No direct per-agent grant, no escape hatch.** `agents.tool_slugs` is gone.
- **Runtime affordances** (not stored grants): heartbeat-control tools and
  `read_result` are injected by the loop based on turn context.

The thing to audit is whether this is **actually true everywhere**, whether the
**migration from the old shape was lossless where it claimed to be**, and whether
the **new single path has gaps** (silent capability loss, provisioning holes,
ordering hazards).

---

## 2. The phases (what each one did)

| Phase | Migration | What shipped |
|---|---|---|
| P0 | `0080` | `tool_groups` table + `agents.tool_group_slugs[]`; 19 default groups seeded but **dormant** (nothing granted them). System unchanged at runtime. |
| P1 | — | Drained skills' tools onto the agents that used them (so dropping skill tools later is lossless). |
| P2 | — | Tool-groups manager UI (`/settings/tool-groups`) + Studio group nodes. |
| P3 | `0081` | Runtime **expands** granted groups into the effective set; existing agents **re-expressed** onto groups via `deriveGroupGrants` (greedy decomposition, behavior-identical: `residual ∪ ⋃(group tools) === full`). |
| P4 | `0082` | Dropped `skills.tool_slugs`. Skills are pure teaching everywhere. |
| P5 | — | Generalist persona **delegates** page/table authoring to specialists (deny-set kept `page_*`/`table_*` out of the persona); groups-first agent editor; self-heal made coverage-aware. |
| P6a | — | **Every manifest agent authored as an explicit tool-group list** (`toolSlugs: []`); taxonomy completed to 27 groups so every grantable builtin lives in ≥1 group; heartbeat tools became a **per-turn affordance**; self-heal grants the core floor as **groups**; dev brain re-granted. Column kept-but-emptied. |
| P6b | `0083` | **Dropped `agents.tool_slugs`.** `effectiveToolSlugs` is group-only; editor "Direct tools" section removed; dead helpers (`deriveGroupGrants`, `resolveManifestToolSlugs`, `DEFAULT_ASSISTANT_TOOL_SLUGS`, `ASSISTANT_TOOL_DENY`, reexpress CLI) deleted. |

> **Note for the auditor:** P3's `deriveGroupGrants` and the dev re-expression
> were claimed *behavior-identical*; P6's specialist re-grant is **deliberately
> not** identical (see §6). Don't conflate the two — different invariants apply.

---

## 3. The runtime resolution path (audit this first — it's the hot path)

Per turn, every responder/agent resolves its tool allowlist the same way:

```
groupTools       = resolveAgentToolGroups(ownerId, agent.toolGroupSlugs)   // ENABLED groups only → flat union of member slugs
allowedToolSlugs = effectiveToolSlugs(groupTools)                          // dedupe + cap at 512
(+ heartbeat affordance, see below)
allowedTools     = resolveAgentTools(ownerId, allowedToolSlugs)            // slugs → ENABLED tool rows
```

Key code:
- `resolveAgentToolGroups` — `packages/agent-runtime/src/skills.ts:51`. Selects
  only `enabled = true` groups; unions their `toolSlugs`.
- `effectiveToolSlugs(groupToolSlugs)` — `packages/agent-runtime/src/skills.ts:101`.
  Single arg now. Dedupe + cap `MAX_EFFECTIVE_TOOL_SLUGS = 512` (logs on overflow,
  slices by insertion order).
- `resolveTools` — `packages/tools/src/dispatch.ts:30`. Filters to `enabled = true`
  tool rows; a slug whose tool row is disabled is silently dropped.

**The four callers** (verify they're identical in spirit and all dropped the
old `agent.toolSlugs ?? []` first arg):
1. Web responder — `apps/web/lib/assistant.ts:349-360`
2. Telegram responder — `apps/agent/src/main.ts:897-902`
3. Heartbeat fire — `packages/heartbeats/src/fire.ts:189-196` (also unions
   `HEARTBEAT_CONTROL_TOOLS`)
4. Delegation — `packages/agent-runtime/src/invoke-agent.ts:117-118`

**Heartbeat affordance** (P6 — was a stored grant + filter-OUT; now inject-IN):
- `HEARTBEAT_RESPONDER_TOOLS` (`heartbeat_complete/snooze/update_state`) are
  injected into `allowedToolSlugs` **only when** `hasActiveHeartbeatsOnSurface`
  is true. Callers: `assistant.ts:354-359`, `main.ts:893-902` (symmetric, deduped).
- `hasActiveHeartbeatsOnSurface(...).catch(() => false)` — on error, **no
  injection** (model can't complete/snooze the heartbeat that turn).
- Fire turns separately union `HEARTBEAT_CONTROL_TOOLS` (includes `_list`/`_fire`)
  in `fire.ts`. `read_result` is offered by the tool-loop regardless.

---

## 4. Provisioning paths (where grants are written — audit for holes)

There are **three** writers of `agents.tool_group_slugs`, plus the editor:

1. **Manifest seeder** — `apps/web/lib/system-manifest/seed.ts`.
   `applyManifest(ownerId, opts)` upserts, in order: tool groups (`upsertToolGroup`)
   → skills → **non-persona** agents (`upsertAgent`). `upsertAgent` writes
   `tool_group_slugs = def.toolGroupSlugs`, no tool_slugs. Modes: `overwrite`
   (full sync) and `gap-fill` (additive: merges new groups/skills, never touches
   prompt/model). **The persona (`isPersona`) is explicitly skipped here** — it's
   created in onboarding.
2. **Onboarding** — `apps/web/lib/onboarding-provision.ts:~217`. Creates the
   persona (`slug='assistant'`) with `toolGroupSlugs = PERSONA_TOOL_GROUP_SLUGS`
   (the manifest persona's list). Repair branch (~`:249`) restores it if a persona
   exists with **empty** `toolGroupSlugs` (the new "toolless" signal).
3. **Boot self-heal** — `apps/agent/src/main.ts:ensureCoreToolsOnConversationalAgents`
   (~`:1420`). For every enabled `responder`/`assistant` agent, grants any missing
   **core floor group** (`CORE_AUTO_GRANT_GROUP_SLUGS` = `persona, todos, contacts,
   lifelog, notes, email, page-share`), unless already held or fully covered by
   another granted group. **This is what keeps OPERATOR personas alive** —
   `telegram-default` (Saskia) and `apostle-paul` are NOT manifest slugs, so the
   manifest never grants them; the self-heal floors them. Writes `tool_group_slugs`.
4. **Editor** — `apps/web/app/(app)/settings/agents/` (server `page.tsx` +
   `agents-client.tsx`). Tool-groups picker only; read-only effective-tools readout.

**Fresh install vs established brain:** prod is fresh → onboarding + applyManifest
produce the correct shape from scratch. The **dev** (established) brain was brought
into line by **throwaway scripts that have since been deleted** (see §7 R9/R10).

---

## 5. The taxonomy (27 tool groups) + agent→group map

Groups (`MANIFEST_TOOL_GROUPS`, `apps/web/lib/system-manifest/manifest.ts:~170`):
`memory-core, files, notes, events, todos, pages, page-admin, page-share, tables,
table-admin, contacts, contacts-admin, lifelog, lifelog-admin, recall,
recall-search, research, email, persona, secrets, ingest, media-workers,
delegation, messaging, tool-results, terminal, federation`.

Design rules to verify:
- **Every grantable builtin lives in ≥1 group** (drift-tested — see §9). Runtime
  affordances (`heartbeat_*`) live OUTSIDE `BUILTIN_TOOLS` and intentionally
  belong to no group.
- **Destructive ops are isolated** in `*-admin` groups (`page-admin`,
  `table-admin`, `contacts-admin`, `lifelog-admin`) so a delete is only ever
  granted deliberately, never as a side effect of an authoring grant.
- **No overlap** between `pages` (authoring), `page-admin` (delete/overwrite),
  `page-share` (share toggles).
- `recall` (`recall_window`, persona) is split from `recall-search` (`find_window`,
  Remy only) so the persona can replay without the specialist search.

Agent → groups (`MANIFEST_AGENTS`):
- **assistant** (persona): `memory-core, files, notes, events, todos, contacts,
  lifelog, recall, email, persona, media-workers, delegation, messaging, secrets,
  ingest, tool-results, page-share` (17 groups → 54 tools). NOT `pages`/`tables`/
  `*-admin`/`terminal`/`research`/`federation`/`recall-search`.
- **pages**: `pages, page-admin, page-share, files, memory-core`
- **tables**: `tables, files, memory-core`
- **remy**: `recall, recall-search, memory-core`
- **researcher**: `research, memory-core`
- **coder**: `terminal, files, memory-core`

`PERSONA_TOOL_GROUP_SLUGS` (manifest.ts) is derived from the persona entry and is
what onboarding seeds.

---

## 6. Intentional behavior changes (do NOT flag these as regressions)

The auditor will see these as deltas vs the pre-refactor state. They are deliberate:

1. **Specialists gained read tools.** Approach A grants specialists the *coarse*
   `files` / `memory-core` groups rather than minting fine-grained subset groups.
   So e.g. the Pages agent now also has `file_create`, `search_chunks`,
   `tree_list`, the `entity_*` tools, `graph_path`. Benign, accepted, **not
   behavior-identical** for specialists. (Verify the additions are exactly the
   coarse-group members and nothing dangerous, e.g. no specialist accidentally
   gained `run_terminal` or a `*_delete`.)
2. **The persona lost `contact_delete` and `lifelog_delete`.** Moved to the
   deliberate-only `contacts-admin`/`lifelog-admin` groups. (Verify no flow
   assumed the generalist could delete a contact/life-log inline.)
3. **`apostle-paul` lost `run_terminal`, `peer_*` (federation), `contact_delete`.**
   This dev operator persona was re-granted the generalist group list in P6a,
   stripping capabilities it previously held flat. **Judgment call on a dev-only
   persona**; flagged to the user. If it should keep shell/federation, the fix is
   adding the `terminal`/`federation` groups in the editor.
4. **Heartbeat tools are no longer a stored grant.** They appear only on turns
   with an active heartbeat (§3).

---

## 7. Risk register — where to dig (honest self-assessment)

Each item: **location · the concern · my assessment · suggested check.**

**R1 — Self-heal depends on the floor groups being seeded AND enabled.**
`ensureCoreToolsOnConversationalAgents` only sees `enabled = true` groups; a
missing/disabled floor group has `tools.length === 0` in its map and is silently
skipped (not granted, no error). · *Assessment:* on a correct install groups are
seeded before agents, so fine; but a brain where someone disabled `notes`/`email`
or where `seed:tool-groups` never ran would silently under-grant the persona. ·
*Check:* disable the `email` group, reboot the agent, confirm what happens to a
conversational agent's effective set and whether anything surfaces it.

**R2 — Capability loss is silent at runtime; only the integrity checker surfaces it.**
Both `resolveAgentToolGroups` (groups) and `resolveTools` (tool rows) filter on
`enabled`. So disabling a group, or disabling a single tool row that a granted
group references, silently removes that capability from every agent — no runtime
error. · *Assessment:* intended (enabled flags are meant to gate), and
`/debug/integrity` checks 7/7c flag dangling/disabled group+tool refs. But the
runtime itself is silent. · *Check:* confirm the integrity checks actually catch
(a) an agent granting a disabled group, (b) a granted group whose member tool row
is disabled. Confirm the editor's effective-tools readout reflects enabled-state
or is honest about not doing so.

**R3 — The 512 cap slices by insertion order.** `effectiveToolSlugs` truncates
the union at `MAX_EFFECTIVE_TOOL_SLUGS = 512` and logs. · *Assessment:* current
max is the persona at ~54; no real risk now, and it logs rather than failing
silently. · *Check:* nothing urgent; just confirm the cap can't be hit by a
plausible group config and that the log is adequate.

**R4 — Worker agents resolve to 0 groups → 0 tools.** `extractor`, `summarizer`,
`reflector`, `document`, etc. have no `toolGroupSlugs`. · *Assessment:* correct —
they're LLM workers, not tool-callers; the tool-loop sends no `tools` param and
reduces to a single call. · *Check:* confirm nothing treats "0 tools" as a broken
agent (the integrity persona check only applies to the persona; verify it doesn't
misfire on workers or on a legitimately tool-less custom agent).

**R5 — Operator personas vs the manifest persona.** The canonical persona is the
manifest `assistant` with 17 groups. Operator-owned personas (`telegram-default`,
`apostle-paul`) get only the **7 floor groups** from the self-heal unless someone
grants them the rest. In P6a they were hand-granted the full generalist list. ·
*Assessment:* a NEW operator persona (or a future brain) would only be floored to
7 groups, not the generalist 17 — it would lack calendar/files/recall/media/etc.
until an operator adds them. Is the floor the intended baseline, or should the
self-heal grant the full generalist set? · *Check:* decide whether
`CORE_AUTO_GRANT_GROUP_SLUGS` (floor) vs `PERSONA_TOOL_GROUP_SLUGS` (full) is the
right self-heal target. This is the most likely **design gap**.

**R6 — The dev re-grant is not reproducible from the repo.** P6a/P6b used
throwaway scripts (`_p6_effdump.ts`, `_p6_persona.ts`, `_p6b_check.ts`) that
verified "no agent loses capability" and performed the re-grant; **they were
deleted after use.** · *Assessment:* the verification happened (results recorded
in the session), but an auditor cannot re-derive it from code. There is **no
committed migration/backfill** that re-grants an established brain — `0083` only
drops the column. · *Check:* for any **non-fresh** deployment, capability must be
re-granted onto groups *before* `0083` runs, or agents lose everything. Confirm
prod is genuinely fresh; if any established brain exists, this is a **data-loss
hazard** with no committed remediation. Consider whether a one-shot backfill
should exist.

**R7 — Migration ordering / running processes.** Dropping `tool_slugs` while a
process compiled against the old schema is running breaks its `SELECT`s (Drizzle
selects the column explicitly). On dev this was safe because `apps/agent` runs
under `tsx --watch` and auto-reloaded on merge; new code never references the
column, so it tolerates the column being present or absent. · *Check:* confirm the
**prod** deploy path applies `0083` and restarts processes in an order that never
runs old code against the dropped column (or new code is column-agnostic, which it
is). Note `apps/agent`'s prod `start` script is **non-watch** `tsx`.

**R8 — Heartbeat affordance end-to-end.** The continuity flow changed from
grant-then-filter to inject-when-active, and `seed-get-to-know-user` no longer
stamps the tools. · *Check:* exercise the full loop — fire a heartbeat, have the
user reply on web and on Telegram, confirm `heartbeat_complete/snooze/update_state`
are actually present that turn and absent otherwise; confirm the prompt's
instruction to "call heartbeat_update_state" lines up with tool availability.

**R9 — `gap-fill` seeding semantics.** `upsertAgent` gap-fill is additive and
only merges groups/skills. · *Check:* confirm re-running a `seed:*` CLI on an
existing agent doesn't drop or duplicate groups, and that an agent created before
P6 (which had residual direct tools) is correctly handled now that the column is
gone.

**R10 — Pre-existing dead column.** `agents.tools` (jsonb, `schema/agents.ts:227`)
is a legacy free-form array, unrelated to this refactor, still present and unused.
Not introduced here; flag only if you want it cleaned up.

**R11 — `tools` registry seeding.** Builtins are seeded into the `tools` table on
boot (`seedBuiltinTools`). Group membership references tool *slugs*; if a builtin
is renamed/removed without updating groups, a group references a non-existent tool.
· *Check:* the drift test guards manifest→registry, but confirm a runtime-added or
removed builtin can't desync groups silently.

---

## 8. Intentional invariants the auditor can assert

1. `agents.tool_slugs` column does **not** exist (it's dropped). No code reads it.
2. For every agent: `effective tools === ⋃(enabled granted groups' enabled tools)`.
   Nothing else contributes (no skill tools, no direct tools).
3. Every slug in `BUILTIN_TOOLS` belongs to ≥1 `MANIFEST_TOOL_GROUPS` group.
   (heartbeat_* are external and intentionally excluded.)
4. No manifest agent carries any direct tool grant (the `toolSlugs` field is gone
   from `ManifestAgent`; agents are pure group lists).
5. `pages` ∪ `page-admin` ∪ `page-share` === the full `PAGE_TOOL_SLUGS` set, with
   no pairwise overlap.
6. The persona's group set excludes `pages`, `tables`, all `*-admin`, `terminal`,
   `research`, `federation`, `recall-search`.
7. Skills contribute zero tools anywhere (`skills.tool_slugs` dropped in `0082`).

---

## 9. Test coverage + gaps

Existing automated coverage:
- **Drift test** — `apps/web/lib/system-manifest/manifest.test.ts` (run from repo
  root: `pnpm exec vitest run system-manifest`). Asserts: every group's tools are
  known builtins; every agent references only known groups/skills and grants ≥1
  group; **every grantable builtin lives in ≥1 group**; the persona excludes
  page/table authoring + the deletes; surface agents hold their surface tools.
- **`effectiveToolSlugs`** — `packages/agent-runtime/src/skills.test.ts` (dedupe,
  empty, cap+log).
- **Heartbeat constant** — `packages/heartbeats/src/tools.test.ts` (the canonical
  `HEARTBEAT_RESPONDER_TOOLS` list).
- **Integrity checker** — exercised via `/debug/integrity` (no unit test for the
  group-aware effective-set logic added in P6).

**Gaps the auditor should weigh:**
- No automated test for the **self-heal** group-grant logic (R1/R5) — the most
  logic-heavy, least-tested piece.
- No automated test for the **runtime resolution path** end-to-end (groups →
  effective → enabled-filtered rows), incl. the disabled-group/disabled-tool
  cases (R2).
- No test that the **heartbeat affordance** injects/withholds correctly (R8).
- No test/backfill for the **established-brain re-grant** (R6) — verification was
  manual and the scripts are deleted.
- The deleted `default-assistant-tools.test.ts` covered the old deny-set; nothing
  replaces it, which is correct (the concept is gone), but confirm the deny logic
  it encoded is fully superseded by the taxonomy.

---

## 10. File surface (where the work lives)

- Manifest / taxonomy / seeding: `apps/web/lib/system-manifest/{manifest.ts,seed.ts,integrity.ts}`
- Onboarding: `apps/web/lib/onboarding-provision.ts`
- Runtime: `packages/agent-runtime/src/{skills.ts,invoke-agent.ts,tool-loop.ts}`,
  `apps/web/lib/assistant.ts`, `apps/agent/src/main.ts`, `packages/heartbeats/src/{fire.ts,tools.ts,tick.ts}`
- Schema/migrations: `packages/db/src/schema/agents.ts`,
  `packages/db/migrations/0080…0083*.sql` (+ `meta/_journal.json`)
- Registry/clusters: `packages/tools/src/builtins*.ts` (group membership mirrors
  the `*_TOOLS` clusters)
- Editor/UI: `apps/web/app/(app)/settings/agents/{page.tsx,agents-client.tsx}`,
  `/settings/tool-groups`, Studio `apps/web/lib/studio/graph.ts`
- Seed CLIs: `apps/web/scripts/seed-*.ts` (mostly thin `applyManifest` wrappers;
  `seed-docs.ts` now grants the `memory-core` group; `seed-get-to-know-user.ts`
  no longer stamps heartbeat tools)

---

## 11. Suggested audit method

1. Re-derive the invariants in §8 against the live code + a real brain (query the
   DB for each agent's `tool_group_slugs`, expand, compare to expectation).
2. Adversarially probe the silent-loss paths (R1, R2): disable a group/tool, watch
   the effective set and the integrity report.
3. Settle the **R5 design question** (floor vs full generalist for non-manifest
   personas) — this is the most likely real gap.
4. Confirm the **R6 deployment hazard** is a non-issue (fresh prod) or needs a
   committed backfill.
5. Run the heartbeat continuity flow (R8) on both surfaces.
6. Sanity-check the §6 intentional deltas are exactly as described and nothing
   dangerous leaked into a specialist via the coarse groups.
