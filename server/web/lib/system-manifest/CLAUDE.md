# system-manifest — the single source of truth

This directory is the **one** declarative source for the default
agent / skill / tool-group / worker / persona graph a Mantle brain ships with.
Onboarding (fresh brains), the boot reconcile (existing brains on upgrade), the
CLI `pnpm seed:*` scripts, and the `/settings/config` checker **all** derive from
[`manifest.ts`](manifest.ts). If you change what the product ships, change it
**here** — never hardcode a model, prompt, grant, or worker anywhere else.

> Onboarding = **manifest + user overlay**. The only things onboarding owns are
> the genuine overlay: which API keys exist, and the persona's name / voice /
> generated prompt (from the persona bank + personality step). Everything
> structural comes from the manifest.

## Where each thing lives

- **Definitions + links:** [`manifest.ts`](manifest.ts) — `MANIFEST_SKILLS`,
  `MANIFEST_TOOL_GROUPS`, `MANIFEST_AGENTS` (incl. the `isPersona` entry),
  `MANIFEST_WORKERS`, `MANIFEST_HTTP_TOOLS`.
- **Prompt + skill BODIES:** [`prompts.ts`](prompts.ts) — `SKILL_INSTRUCTIONS`
  and `AGENT_PROMPTS`; the manifest references them by slug.
- **Seeder (DB writes):** [`seed.ts`](seed.ts) — `applyManifest`,
  `seedToolCapabilities`, `seedManifestWorkers`.
- **Upgrade path:** [`reconcile.ts`](reconcile.ts) — what reaches existing brains.
- **Drift visibility:** [`config-diff.ts`](config-diff.ts) (the `/settings/config`
  checker) + [`integrity.ts`](integrity.ts) (referential checks).
- **CI guard:** [`manifest.test.ts`](manifest.test.ts) fails the build on a
  dangling/typo'd slug. Pure helpers (`worker-route.ts`, `reconcile-util.ts`,
  `group-checks.ts`, `config-diff.ts`) have co-located `*.test.ts`.

## The propagation contract — what reaches an EXISTING brain on upgrade

The boot reconcile runs once per `APP_VERSION` (production, best-effort). It is
**additive and product-owned-only**:

| Manifest change | Reaches existing brains automatically? | How |
|---|---|---|
| Tool-group membership | ✅ overwrite | `seedToolCapabilities` |
| Skill **body** (`SKILL_INSTRUCTIONS`) | ✅ overwrite | `applyManifest` `skillMode` |
| **Persona** skill links (by ROLE — reaches operator personas too) | ✅ **converge** — add new + **drop a retired** manifest skill (e.g. `rich_writing`); operator skills kept | `reconcilePersonaCapabilitiesByRole` |
| Persona default tool groups (by ROLE) | ✅ union (add-only) | `reconcilePersonaCapabilitiesByRole` |
| New **specialist** agent | ✅ create + wire delegation | `provisionMissingSpecialists` |
| Specialist tool groups | ✅ union (add-only) | `grantSpecialistCapabilities` |
| Specialist skill links | ✅ **converge** — add new + **drop a retired** manifest skill; operator skills kept | `grantSpecialistCapabilities` |
| Specialist prompt / model / params | ✅ overwrite | `syncSpecialistDefs` |
| New **required** worker | ✅ create | `seedManifestWorkers({requiredOnly})` |

**Deliberately NOT auto-propagated** (operator-owned / overlay):
- Persona **prompt / model / params** — operator-owned; never touched.
- An existing **worker's model/provider** — operator cost choice; never overwritten.
- New **optional** workers — fresh onboarding only.
- **Removals** — mostly additive, with ONE exception: an agent's **skill links**
  converge, so dropping a skill from an agent's manifest `skillSlugs` (e.g.
  `rich_writing` off the persona) DOES detach it on upgrade — but only for skills
  the manifest owns; operator-authored skill links are never touched. Everything
  else is still add-only: removing a tool group from an agent, removing a skill/
  group/agent **row** entirely (the row lives on — disable to opt out, delete by
  operator action), and a default group an operator deliberately dropped (it
  reappears).
- **Operator-authored** skills/agents (not in the manifest) — never seen, never
  clobbered. (Named operator personas like `telegram-default`/Saskia are NOT
  manifest slugs.)

## How to make a change

- **Edit/fix a skill body:** change `SKILL_INSTRUCTIONS['<slug>']` in `prompts.ts`.
  It force-syncs to every brain on upgrade. Done.
- **Add a new skill:** add a `MANIFEST_SKILLS` entry (+ its `SKILL_INSTRUCTIONS`
  body), then attach it via `skillSlugs` on the persona and/or specialists in
  `MANIFEST_AGENTS`. Both the body and the agent links now propagate.
- **Detach a default skill from an agent:** remove its slug from that agent's
  `skillSlugs` in `MANIFEST_AGENTS`. The reconcile **converges** skill links, so it
  detaches on existing brains too (the `rich_writing` → `chat_writing` move is the
  reference case). Leave the `MANIFEST_SKILLS` entry if another agent still uses it
  (e.g. `rich_writing` stays for Pages). Operator-authored links are never touched.
- **Add/change a specialist:** edit its `MANIFEST_AGENTS` entry (+ `AGENT_PROMPTS`).
  Prompt/model/params force-sync; groups + skills union; a brand-new specialist is
  auto-provisioned with delegation wired.
- **Tool group:** edit `MANIFEST_TOOL_GROUPS` (membership overwrite-syncs). Grant
  it by adding the slug to an agent's `toolGroupSlugs`.
- **Worker:** edit `MANIFEST_WORKERS` (provider / model / params / optional xAI
  alt route). Worker models live **only** here.
- **Persona:** structural fields (model/params/`memoryConfig`/tool groups) go in
  the `isPersona` entry. **Do not** put a persona prompt in the manifest — it's
  the one overlay, generated in [`onboarding-provision.ts`](../onboarding-provision.ts).

## Always, before you finish

1. `pnpm exec vitest run apps/web/lib/system-manifest/` (from repo root) — drift
   guard + pure-logic tests.
2. `pnpm --filter @mantle/web run typecheck`.
3. If you added a field other code reads (e.g. a new `ManifestWorker` field),
   update its consumers: `config-diff.ts`, `integrity.ts`, the seeder.
4. Eyeball `/settings/config` — it shows exactly how a live brain now differs
   from your template (and confirms nothing drifted unexpectedly).

To force a single item onto an existing brain immediately (instead of waiting for
the version-bump reconcile): `ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:<agent|tool-groups|…>`.
