# Session handover — Mantle fresh-install test in progress

> **TL;DR.** Just finished a multi-day arc: independent **audit follow-up** on the
> tools/skills refactor, then **open-source prep** (genericize hard-coded personal
> data; clean up legacy scripts), then **DX hardening** for the fresh-install
> path. Jason is now running through onboarding **on a freshly-wiped dev brain**
> as an open-source user would. The dev brain is being rebuilt as Jason's new
> production. Last interactive moment: I wiped his dev volumes; he's about to
> run `pnpm start` and onboard. Pick up by verifying his onboarding went clean and
> running `/debug/integrity`.

---

## 1. What just happened — the arc (v0.20.5 → v0.20.15)

### Phase A: Audit follow-up — tools/skills refactor (P0–P6c)

Adversarial audit (docs/audit-brief-tools-skills.md) of the completed
tools-and-skills split. Audit findings, all **fixed and merged to main**:

- **R5 (S1, v0.20.6) — floor sufficiency.** `CORE_AUTO_GRANT_GROUP_SLUGS` in
  `apps/agent/src/main.ts` was a 7-group floor that lacked `memory-core` +
  `delegation`. A self-healed-only persona would fail integrity's persona check
  (no `invoke_agent`) and couldn't ground answers (no `search_*`). Logic was
  extracted to **`apps/agent/src/core-tools.ts`** (`computeFloorGroupAdditions`)
  + unit-tested; `memory-core` + `delegation` added to the floor. The fix is the
  functional minimum, not the full generalist — by design, so a locked-down
  custom responder isn't over-granted.
- **R8 (S2, v0.20.6) — web heartbeat dispatch.** `apps/web/lib/assistant.ts`
  injects heartbeat continuity tools (`heartbeat_update_state/complete/snooze`)
  when a web-surface heartbeat is active, but the handlers only enter a
  process's builtin registry via `registerHeartbeatTools()`. apps/agent calls
  it at boot, apps/web didn't — so dispatch on web silently failed (handler
  not registered). Added `registerHeartbeatTools()` at module load in
  `apps/web/lib/assistant.ts:79` (next to `registerAgentInvoker`). Pinned by
  `packages/heartbeats/src/tools.test.ts` (register→dispatchable contract).
- **R6 (S3, v0.20.6) — established-brain backfill.** Migration `0083` dropped
  `agents.tool_slugs` without a slug-based backfill, so any brain that ran
  0080→0083 without the (deleted) re-expression script would lose every
  specialist's capability. Added **migration `0084_backfill_agent_tool_groups.sql`**
  — re-grants the 6 manifest agents by slug when `tool_group_slugs = '{}'`.
  No-op on fresh installs (no rows yet) and on the dev brain (already granted).
- **M1+M2 (v0.20.7) — integrity surfacing.** `/debug/integrity` check 7
  ("group-tools") didn't catch disabled manifest groups (the runtime + self-heal
  drop them silently) or custom-group tool resolution. Logic extracted to
  **`apps/web/lib/system-manifest/group-checks.ts`** + unit tested; now flags both.
- **N1+N2+N3 (v0.20.9) — housekeeping.** Migration `0085` drops the dead
  legacy `agents.tools` jsonb column (the pre-P6 free-form MCP name array; its
  CRUD-lib + API plumbing also gone). Group descriptions for `pages`/`tables`
  reworded — block/row/column deletes ARE in the authoring set; only the
  whole-object delete is isolated to `*-admin`. Removed stray `test-tool` row
  from dev.

Everything in `docs/tools-and-skills.md` (canonical) + `docs/audit-brief-tools-skills.md`.
`docs/system-integrity.md` + `apps/web/lib/system-manifest/manifest.test.ts`
remain the runtime guardrails. Memory note at
`~/.claude/projects/-Users-jasonschoeman-Projects-mantle/memory/project_tools_skills_split.md`
is up to date with the P6c audit follow-up.

### Phase B: Open-source prep (v0.20.10 – 0.20.13)

Jason is shipping Mantle as **open-source**, with his fresh production-rebuild
as the first real deployment. He requested: **never bake personal data into
seeded/default content**. The persona bank
(`packages/content/src/persona-bank.ts`) was already name-agnostic by design.

- **v0.20.10** genericised every SEEDED/RUNTIME/USER-FACING/AI-FACING surface
  and dev comments. Placeholders throughout: **Alex Carter / "the user"** for
  names, **alex@/you@example.com** for emails, **Acme / Globex Accounting** for
  orgs, **Maria** for summary examples. Covered: 5 specialist prompts in
  `apps/web/lib/system-manifest/prompts.ts`, worker prompts (summarizer/extractor/
  reflector), onboarding placeholders (`packages/content/src/onboarding-questions.ts`),
  MCP tool descriptions, contact tool + format, inbox empty-state, agents-editor
  defaults, regenerate-digests, and all dev/schema comments (facts/heartbeats/
  emails schema, entity-dedup, person-names, account-branch, conversation,
  search/files/email path docs, integrity audit note).
- **v0.20.11** specialist prompts no longer hard-name the orchestrator —
  *"Saskia (the main assistant) delegates…"* → *"The main assistant delegates…"*
  Important: a renamed persona stays coherent (specialists previously referred to
  a "Saskia" that wouldn't exist after rename). Deleted
  **`apps/web/scripts/seed-shared-skills.ts`** + its `seed:shared-skills`
  package.json entry — the genuine legacy script (hard-wrote a SASKIA_PROMPT
  full of "Jason" + a home-server IP). **The other 4 "seed-*" scripts
  (`seed-remy.ts`, `seed-researcher.ts`, `seed-pages-agent.ts`,
  `seed-tables-agent.ts`) are LIVE thin wrappers around `applyManifest` — KEPT,
  only stale comment headers genericised.**
- **"Saskia" is intentionally KEPT** as the default persona name
  (`DEFAULT_PERSONA_NAMES.female` in persona-bank.ts) + UI copy / tool
  descriptions / voice catalogs — that's a legitimate shipped default, not
  personal data. Only de-named where a *specialist/seeded prompt* referred to
  the orchestrator by name.
- **v0.20.12** README "First-time setup" added Step 4 — **install local
  Ollama** (`brew install ollama && brew services start ollama && ollama pull
  embeddinggemma`) — with a callout explaining why (dev compose ships
  Postgres+MinIO+Tika only; embedder is your local Ollama). Added "Dev vs
  production" note: production is meant for **Linux** via full
  `docker-compose.yml`, which **bundles the embedder** + a one-shot model pull,
  so a fresh deploy needs no native Ollama. Points to `docs/deploy.md`.
- **v0.20.13** Correction — earlier I told Jason "onboarding doesn't touch
  Telegram"; it **does** (step 9, optional/skippable, uses the same
  `<TelegramBotSection>` as `/settings/agents`). Fixed the README Telegram
  section (stale storage detail — it's `channels.credentials_enc` now;
  `telegram_accounts.responder_agent_id`/`bot_token_enc` were dropped in
  migration 0078). Added cross-reference in `docs/onboarding.md` §3 and a
  forward-pointing muted note in the onboarding Personality step UI.

Remaining personal-data refs (not done — no runtime/user impact): test
fixtures (~11) + `apps/web/components/examples/*` demo data. **Cosmetic only.**

### Phase C: DX hardening for fresh-install (v0.20.14 – 0.20.15)

Jason's fresh-install test surfaced two real bugs:

- **v0.20.14 — pg-boss race on fresh DB.** A storm of `relation "pgboss.version"/
  "pgboss.job" does not exist` (42P01) hit when **multiple workers call
  `pg-boss.start()` concurrently on a brand-new DB and race on schema creation**.
  Confirmed by isolated probe: a single `start()` creates the schema fine. Fix:
  materialise the schema deterministically **before** any worker starts.
  Created **`apps/web/scripts/pgboss-init.ts`** (one `start()`+`stop()`,
  idempotent). Wired into:
  - `scripts/up.sh` (dev) — runs `pgboss:init` after Drizzle migrate.
  - `docker-compose.yml` (prod) — the `migrate` one-shot now runs
    `pnpm -C packages/db migrate && pnpm -C apps/web pgboss:init`. Every worker
    `depends_on: migrate: { condition: service_completed_successfully }`, so by
    the time they call `start()` the schema exists.
  - `apps/web/package.json` — `"pgboss:init"` script entry.

  **Affects every fresh install, dev and prod.**
- **v0.20.15 — DX preflight + reset.** Jason hit the symptom: ran `pnpm dev`
  against down infra, got 30s of cryptic `ECONNREFUSED 127.0.0.1:54323` Next.js
  stack traces. Same for anyone who Ctrl-C's `pnpm start` mid-stream. Hardened:
  - **`scripts/preflight-dev.sh`** — wired as `predev` / `predev:web` /
    `predev:agent` hooks in root `package.json`. Checks docker, mantle_pg
    health, postgres acceptance, pgboss schema. Silent on success; on failure
    prints a one-screen message with the exact next command (`pnpm start` /
    `pnpm infra:up` / `pnpm reset`).
  - **`scripts/reset.sh`** — one confirmed-wipe-and-rebuild command. Backs up
    the brain best-effort, `down -v`, comments out the stale `ALLOWED_USER_ID`
    pin (otherwise workers stick to a deleted user), exec's `up.sh`. Wired as
    `pnpm reset`. **This is the "I'm stuck" recovery command.**

---

## 2. Where we are RIGHT NOW (interactive)

**Jason just told me to stop all containers + wipe, so he can run `pnpm start`
as a true cold-start open-source user.** I did that. State:

| | |
|---|---|
| **Dev containers** | none (wiped) |
| **Dev volumes** | `mantle_mantle_pg_data` + `mantle_mantle_minio_data` removed |
| **Pre-wipe backup** | `backups/mantle-20260606-114037.dump` (172K) |
| **Owner pin** | `ALLOWED_USER_ID` commented in `apps/web/.env.local` (line 22-24) |
| **Source tree** | main @ `b70a419`, v0.20.15 — all fixes in |
| **mantlenew, prod** | **untouched** (mantlenew is at `~/Projects/mantle-new`, a separate checkout; prod is on the Contabo VPS) |
| **Native Ollama** | running on Jason's Mac at `localhost:11434` with `embeddinggemma:latest` (so dev embeddings will work without any extra setup) |

**Jason is about to run `pnpm start`** from `~/Projects/mantle`. He's been given
prepped copy-paste answers for the 10-question onboarding interview (his own,
pulled from a prior brain backup — see §6 below).

---

## 3. What's next — immediate task

Once Jason finishes onboarding, the verification path is:

1. **Confirm no pg-boss errors in the logs.** That validates the v0.20.14 fix.
2. **Run `/debug/integrity` → System tab.** Should be all green (persona can
   act + delegate; specialists seeded; delegation wired; workers ready;
   tool-groups resolve). The persona will be the manifest `assistant` slug —
   not `telegram-default` like his old prod brain — so the integrity check
   resolves it directly (no `resolveEffectivePersona` fallback needed).
3. **Confirm Saskia replies to her first Telegram DM** (if Jason connected the
   bot during onboarding; otherwise he'll do it in `/settings/agents`).

After verification: Jason will start **ingesting his real data** — emails,
files, sermons — and we'll check every "brain touch" (extractor / summarizer /
reflector / entity-dedup / search / recall). He's flagged he'll later ask me
to **copy his email account creds + Telegram bot token from his prod VPS**.
Prod is `ssh cwe@mcp.crossworks.network` (memory note `reference_prod_box.md`).

**This dev brain is becoming his new production.** Treat it as such — but he
may wipe again if onboarding surfaces another bug. Be ready for that.

---

## 4. Critical context the new session must know

**The big picture (memory: `user_mantle_vision.md`).** Mantle is Jason's
self-hosted AI brain — short/medium/long-term memory over his life, work,
church, family. Single-user. Going open-source. He'll deploy fresh to his
Contabo VPS once dev is solid.

**Worktree.** I've been working in
`~/Projects/mantle/.claude/worktrees/pensive-pasteur-31852e`. Commits have
been ff-merged to **main** (`~/Projects/mantle`) so the dev stack picks them
up. Bump version (`pnpm version:bump patch`) before every merge per Jason's
preference (memory: `feedback_bump_version_before_merge.md`).

**Communication style with Jason.**
- Tight, direct. Lead with the answer, then the why.
- Verify against live code/state before answering — don't trust memory or
  the brief. He values "checked it, here's what I found" over "I remember…"
- Acknowledge corrections explicitly when you've been wrong (I told him
  "onboarding doesn't touch Telegram" — it does; correcting it openly
  preserved trust).
- He runs Mac + Linux only (memory: `user_machines.md`). No Windows.
- Worktree workflow + ff-merge per change; **push only when he asks** (memory:
  `feedback_work_in_main.md`).

**Mac dev quirk: native Ollama.** Jason's Mac has native Ollama running on
`:11434` with `embeddinggemma:latest`. The dev compose deliberately omits
the embedder for this reason (faster, uses Mac GPU). The app defaults to
`http://localhost:11434/v1` so it just works. The **prod compose
(`docker-compose.yml`)** bundles `ollama` + `ollama_pull` services and gates
`web`/`agent` on the model pull — so a fresh Linux deploy needs no native
Ollama. Both paths are documented in README + `docs/deploy.md`.

**Key invariants to NOT break.**
- The runtime resolution path: `resolveAgentToolGroups → effectiveToolSlugs →
  resolveAgentTools` (group-only; `agents.tool_slugs` is GONE, dropped in 0083).
  The 4 callers: `apps/web/lib/assistant.ts:348`, `apps/agent/src/main.ts:891`,
  `packages/heartbeats/src/fire.ts:191`, `packages/agent-runtime/src/invoke-agent.ts:117`.
- Heartbeat tools are a **per-turn affordance**, not a stored grant
  (`hasActiveHeartbeatsOnSurface` → inject). Both surfaces must register
  the handlers at boot (`registerHeartbeatTools()` — apps/agent's `main.ts:107`
  and apps/web's `assistant.ts:79`).
- The system manifest (`apps/web/lib/system-manifest/manifest.ts`) is the
  single source of truth for the default agent/skill/tool/worker graph. CI
  drift test: `pnpm exec vitest run system-manifest`.
- Migration runner is **per-migration-transaction** (memory:
  `reference_migrate_runner.md`). Don't add+use an enum value in one file.

**Things flagged but NOT done (deferred — Jason's call):**
- Cosmetic: ~11 test fixtures + 3 demo components in
  `apps/web/components/examples/*` still reference "Jason / Saskia". No
  runtime impact; cleanup if polishing the public repo.
- README line 3 still says *"Jason's AI-queryable life tree … sermons,
  secrets, and printer projects"* — most visible personal reference, but
  it's the product tagline (branding call, not mechanical swap).
- `ollama_pull` resilience: if the first-boot model pull hiccups (network),
  `web`/`agent` stay down. Worth adding retry/backoff before wide
  open-source release.

---

## 5. Reference — files / commits / paths

**Key files this arc touched (most likely to need review):**
- `apps/agent/src/core-tools.ts` + `.test.ts` — floor decision logic (R5)
- `apps/web/lib/assistant.ts:79` — `registerHeartbeatTools()` (R8)
- `apps/web/lib/system-manifest/group-checks.ts` + `.test.ts` — disabled-group
  surfacing (M1/M2)
- `apps/web/scripts/pgboss-init.ts` — fresh-install schema bootstrap (v0.20.14)
- `scripts/preflight-dev.sh` + `scripts/reset.sh` — DX (v0.20.15)
- `packages/db/migrations/0084_backfill_agent_tool_groups.sql` — re-grant safety net
- `packages/db/migrations/0085_drop_agents_tools_legacy.sql` — drop dead column
- `apps/web/lib/system-manifest/prompts.ts` — specialist prompts (genericised)
- `packages/content/src/onboarding-questions.ts` — wizard interview
- `apps/web/app/onboarding/onboarding-client.tsx` — wizard UI (Telegram note in
  personality step ~line 514)

**Key docs:**
- `README.md` — first-time setup, Telegram, Linux production note
- `docs/audit-brief-tools-skills.md` — the audit; reference for "why we did X"
- `docs/tools-and-skills.md` — canonical end state (P0–P6c)
- `docs/onboarding.md` — wizard flow
- `docs/deploy.md` — Linux production (Contabo VPS, bundled embedder)
- `docs/comms-channels.md` — generic channels (Telegram attach)

**Commits (all on main):**
```
b70a419 v0.20.15  fix(dx): preflight `pnpm dev` + add `pnpm reset` for clean wipes
3e238f9 v0.20.14  fix(fresh-install): create pg-boss schema before workers race on it
6e0406e v0.20.13  docs+onboarding: clarify Telegram setup
25912b9 v0.20.12  docs(readme): macOS local-embedder setup + clarify Linux production
173e8af v0.20.11  chore(oss): degeneric specialist→orchestrator naming + drop legacy seed script
993b643 v0.20.10  chore(oss): genericize hard-coded personal data
a6c5185 v0.20.7   fix(integrity): surface disabled groups + custom-group tool gaps (M1/M2)
6ac7d5b v0.20.6   fix(tools): close audit gaps R5/R8/R6 in the tools/groups split
```

---

## 6. Reference — Jason's onboarding answers (prepped for paste)

Pulled from his pre-wipe brain (in `backups/mantle-20260606-100125.dump`). All
10 answers, lead-prefix stripped — paste as-is per field.

```
1. What's your name?
Jason Schoeman

2. What do you like to be called?
Jason, JC, Jase

3. Do you have a partner or spouse?
My wife, Ashley Ann, married for 9 years

4. Who else is close family — children, parents, who's at home?
Two kids, Benjamin (Benji) 7 years old boy and Isabella (Bella) 3 year old girl.
My mom lives with us, her name is Jenny Schoeman, I have five brothers, Don,
Jonathan, Ruben, Christiaan and Adriaan. I also have one sister Jeanine.

5. What do you do?
I run my own engineering company called Cross Works Engineering that employes
myself, my wife, my brothers Christiaan Schoeman, Jonathan Schoeman. We are in
software engineering, reliability analyst (wife RBI engineer) and we also have
our own designed 3D printer brand called Lister. Also responsible for the design
of Mantle brain system. I am a also a serving Pastor.

6. Is faith or a worldview part of your life?
I am a Christian, and a Pastor at the Barrydale Fellowship Church, South Africa,
Western Cape. I believe in the simple gospel of Jesus Christ, not by works but
by faith are we saved.

7. Anything about your health worth knowing?
I am a healthy person, working out at least 4x a week. I am allergic to nothing.

8. What are you into — how do you spend your time?
Engineering, hiking, working out, writing sermons and preaching, playing with
my children, doing maintenance around the house, visiting congregation, writing
software, designing 3d printers.

9. What are you working toward right now?
Shipping Mantle and getting my gantry 3D printer redesign done. Our biggest
contractor called ACM Track or ACM Tech is contracting out our abilities to
engineer fleet manager solutions. I am working on Destiny Fleet Manager and
Android and iOS mobile apps. I wish to suspend this contract and make enough
money with Mantle to replace this contract.

10. Anything else your assistant should always know about you?
Be on my side, protect my interest, be my friend, treat me well and I will
treat you well.
```

**Personality step:** Warm preset, name *Saskia*, female (voice picks accordingly),
default creativity (~0.7).

---

## 7. First thing to do in the new session

Don't re-investigate the arc — read this file + the project's MEMORY.md index +
the canonical docs (`docs/tools-and-skills.md`, `docs/onboarding.md`,
`docs/deploy.md`) only as needed.

**Pick up by asking Jason where he's at:** mid-onboarding? Through?
Hit something? — and from there:

- If through onboarding cleanly: run **`/debug/integrity` → System tab**
  verification first. Confirm zero pg-boss errors in logs. Then help with
  Telegram bot connect → first DM → Saskia reply test.
- If hit a snag: diagnose against live state (`docker exec mantle_pg psql …`
  for DB introspection; `docker logs` / dev-server output for logs). The
  preflight + reset scripts are there to recover cleanly.
- If he wants to ingest data: standard brain-touch verification — drop a file
  / send an email / send a Telegram message; watch extractor → summarizer →
  reflector pipeline; verify the indexed result via search.

Good luck. Jason is sharp, direct, and patient when you're rigorous — and
quick to flag when you're not.
