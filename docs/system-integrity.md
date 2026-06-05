# System integrity — one manifest for the agent/skill/tool/worker graph

> A provisioned Mantle is a graph of **agents → skills → tools** plus **ai_workers**.
> Those links used to be defined and wired across a dozen CLI seed scripts,
> duplicated in onboarding + the sanity checks, and they degrade **silently** at
> runtime (a missing skill/tool is just dropped, no error). This subsystem makes
> the graph honest: one declarative **manifest** is the source of truth, a CI
> **drift-test** fails the build on a dangling link, and a standing **checker**
> surfaces live drift.

Shipped 2026-06. Code lives in `apps/web/lib/system-manifest/`.

---

## 1. Why this exists

Adding a specialist agent used to mean editing 5–7 files (a new seed script, the
onboarding stack, the sanity-check list, the assist-binding map, `package.json`,
…) — and they drifted: `runSanityChecks` was missing `coder` for a while even
though onboarding seeded it. Worse, the runtime resolvers
(`resolveAgentSkills`, `resolveAgentTools`) **silently drop** a skill/tool whose
row is missing or disabled, so a broken link looks "set up" but is dead. There
was no standing check of the config graph (the `/debug/integrity` audit only
covers the brain corpus).

The fix is the pattern Mantle already uses for providers
(`packages/voice/src/providers.ts` + its `catalog-consistency.test.ts`): a
closed-set declarative catalog guarded by a drift test.

---

## 2. The manifest — single source of truth

`apps/web/lib/system-manifest/manifest.ts` declares the **default** system:

- `MANIFEST_SKILLS` — `slug`, `name`, `toolSlugs` (builtin slugs it bundles),
  `instructions` (the body, from `./prompts.ts`).
- `MANIFEST_AGENTS` — `slug`, `role`, `model` (+ `envModelVar`), `toolSlugs`
  (or the `'DEFAULT_ASSISTANT'` sentinel → `DEFAULT_ASSISTANT_TOOL_SLUGS`),
  `skillSlugs`, `isDelegate` (does the persona delegate to it), `assistSurface`
  (`'pages'`/`'tables'` → the editor Assist panel binding), `systemPrompt` (from
  `./prompts.ts`; the persona has none — its prompt is built from the persona
  bank), `params`, `priority`. One entry is `isPersona: true` (slug `assistant`).
- `MANIFEST_WORKERS` — the ai_worker `kind`s + canonical models, `required`
  marking the always-on indexing pipeline (extractor/summarizer/reflector/document).

Derived selectors remove the duplication:

- `DELEGATE_SLUGS` = agents with `isDelegate` → the persona's `delegate_to`.
- `ASSIST_SURFACE_DEFAULTS` = `{ pages, tables }` → `lib/assist-agent.ts`'s
  `DEFAULT_ASSIST_SLUG` is now **derived from this**, not a hardcoded literal.
- `KNOWN_TOOL_SLUGS` = `BUILTIN_TOOLS` slugs + `KNOWN_EXTERNAL_TOOL_SLUGS`
  (heartbeat controls register only in the agent process — see §6).

The verbatim prompt/instruction bodies live in `./prompts.ts` (`SKILL_INSTRUCTIONS`,
`AGENT_PROMPTS`) so the manifest stays scannable.

**Not in the manifest:** operator-owned personas like `telegram-default`
(Saskia) and `apostle-paul`. The manifest defines DEFAULTS; operator agents
coexist and are never seeded or clobbered by anything derived from it.

The manifest is **server-only** (it imports `@mantle/tools`). Every consumer —
the seeder, the checker, onboarding, the `/debug` route — is server-side.

---

## 3. Three consumers, one source

### a. CI drift-test — `manifest.test.ts`

Pure (no DB). Fails `pnpm test` if anything dangles: a skill/agent referencing an
unknown tool slug, an agent referencing a non-manifest skill, a delegate target
that isn't an agent, a duplicate slug, a non-unique assist surface, a dangerous
tool (`run_terminal`/`page_delete`) leaking into the persona grant, a skill
without instructions, or a specialist without a system prompt. **This is how a
new tool/skill gets kept honest** — a typo fails the build, not production.

### b. The seeder — `seed.ts` `applyManifest(ownerId, opts?)`

The single seeding path. Seeds: builtin tool rows (`seedBuiltinTools`) → skills →
specialist agents → delegation wiring → the persona's skill attach. The persona
*agent* is NOT created here (onboarding-provision creates it with the persona-bank
prompt + the chosen voice/key); `applyManifest` only attaches its skills + wires
delegation to it.

Two modes:

- **`gap-fill`** (default, onboarding) — create what's absent; on an *existing*
  agent NEVER overwrite `systemPrompt`/`model`/`params` (operator customisations),
  only union `skillSlugs`, set `toolSlugs` if empty, ensure `enabled`. Existing
  skills are left untouched. Re-running the wizard can't clobber edits.
- **`overwrite`** (CLI `seed:*`) — upsert rows to the canonical manifest definition.

`opts.only` filters which agent slugs to seed; `opts.onlySkills` which skills.
Delegation wiring is **slug-agnostic**: each in-scope `isDelegate` specialist is
appended to every enabled responder/assistant's `delegate_to` (so it works whether
the persona is the manifest `assistant` or an operator persona like Saskia).

Consumers:
- `onboarding-provision.ts` `seedSpecialistStack` → `applyManifest(ownerId)` (gap-fill).
- The 8 CLI scripts (`pnpm -C apps/web seed:{pages,tables,remy,researcher,coder,
  rich-writing,tables-skill,shared-skills}`) are **thin wrappers** →
  `applyManifest(o, { only/onlySkills, mode: 'overwrite' })`. `seed:shared-skills`
  additionally keeps its operator-persona wiring (`telegram-default`/`apostle-paul`
  + `SASKIA_PROMPT`) inline. **The scripts import the seed module by RELATIVE path**
  (`../lib/system-manifest/seed`) — `tsx` doesn't resolve the `@/` tsconfig alias,
  and the barrel pulls `integrity.ts`'s `@/` chain.

### c. The live checker — `integrity.ts` `checkSystemIntegrity(ownerId)`

Loads the real DB rows and compares them to the manifest + validates referential
integrity — catching the silent-drop cases. Returns severity-tagged
`SystemCheck[]` (`apps/web/lib/integrity/types.ts`, reuses `AuditSeverity`):

| check | what it asserts |
|---|---|
| Persona agent | the persona exists + enabled + has tools + `invoke_agent` + the grounding skills. **Slug-flexible** (`persona.ts` `resolveEffectivePersona`): anchors on slug `assistant`, but on a brain with no `assistant` slug falls back to the highest-priority enabled responder (role `assistant` before `responder`, mirroring `resolveAssistantAgent`), so a hand-built/operator persona is measured against the persona it actually has. The label shows the resolved slug. |
| Specialist agents | each manifest specialist exists + enabled |
| Delegation wiring | the persona's `delegate_to` includes every available specialist |
| Agent ↔ skill links | each agent carries its manifest `skillSlugs` |
| Dangling tool refs | EVERY agent's `tool_slugs` resolve to an enabled tool row (incl. operator agents) |
| Dangling skill refs | EVERY agent's `skill_slugs` resolve to an enabled skill |
| Skill ↔ tool links | each manifest skill's bundled tools resolve |
| Memory workers | a default+enabled worker for each `required` kind |
| Editor Assist binding | `resolveAssistAgentSlug` resolves for /pages + /tables |

Surfaced two ways:
- **`/debug/integrity` → "System config" tab** — runs `checkSystemIntegrity` on
  open (once, on mount), re-runnable, with expandable per-finding samples.
  (`GET /api/debug/integrity/system`.)
- **Onboarding's "Check" step** — `runSanityChecks` calls the *same* checker, so
  the wizard and the debug surface can't drift.

---

## 4. Adding a new specialist / skill / tool

- **New specialist agent:** add one `ManifestAgent` entry (+ its prompt in
  `prompts.ts`). It's automatically seeded by onboarding, wired into delegation,
  checked, and (if `assistSurface` set) bound to an editor panel. Add a thin CLI
  wrapper script only if you want a `pnpm seed:<x>` entrypoint.
- **New skill:** add one `ManifestSkill` entry (+ instructions). The drift-test
  validates its tools exist; agents reference it by slug.
- **New tool:** add it to `@mantle/tools` (`BUILTIN_TOOLS`). The drift-test +
  `DEFAULT_ASSISTANT_TOOL_SLUGS` (registry-derived) pick it up; reference it from
  a manifest skill/agent's `toolSlugs`.

---

## 5. Reading the System tab (expected states)

Green = every vital link resolves. A red row's badge is the **sample count**;
expand it for specifics.

The **Persona agent** + **Delegation wiring** checks are **slug-flexible**: they
anchor on the canonical slug `assistant`, but a brain hand-built before
onboarding existed (e.g. the dev brain, whose persona is `telegram-default`/
Saskia) has no `assistant` slug, so the checker falls back to the
highest-priority enabled responder and measures *that* persona — the label shows
the resolved slug. Such a brain now reads green when its real persona is wired
correctly (tools + `invoke_agent` + grounding skills + delegation), instead of
showing two reds for a slug it never had. A genuinely missing/broken persona
(no enabled responder at all, no tools, no grounding skills) still reads red.

---

## 6. Known edges

- **Heartbeat tools in the web process.** Heartbeat control tools
  (`heartbeat_*`) register into the builtin registry only in the **agent** process
  (`apps/agent` calls `registerHeartbeatTools()` before `seedBuiltinTools`). The
  web process (onboarding) never registers them, so `applyManifest`'s
  `seedBuiltinTools` won't seed their rows — they land when the agent next boots.
  `DEFAULT_ASSISTANT_TOOL_SLUGS` deliberately excludes them, so nothing references
  a missing row. `KNOWN_EXTERNAL_TOOL_SLUGS` documents them for the validator.
- **The persona's tool grant** is `DEFAULT_ASSISTANT_TOOL_SLUGS` (in
  `@mantle/tools`) — `BUILTIN_TOOLS` minus a deny-set (`run_terminal`,
  `page_delete`, the `table_*` grid tools → delegate to Ledger, `web_search`/
  `find_window` → delegate to Researcher/Remy, federation `peer_*`). 68 tools.
