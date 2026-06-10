# Onboarding — from a clean brain to a working assistant

> A fresh Mantle clone boots into a working brain with **no SQL and no env
> editing**: clone → `pnpm start` → open the browser → create an account → walk a
> nine-step wizard that adds model keys, provisions the assistant + AI workers,
> runs a sanity check, captures who you are as Life Logs, and shapes the
> assistant's personality. Everything it sets up is editable later under
> Settings.

Shipped 2026-06. Route `/onboarding`; signup at `/login` (first-run mode).

---

## 1. Why this exists

Before this, a new install was author-only: you hand-inserted a row into
`auth.users` with `psql`, filled `ALLOWED_USER_ID` in `.env`, restarted, then
hand-built every agent and AI worker at `/settings/*`. The onboarding system
removes all of that so an open-source user can go from clone to a brain that
remembers, in minutes.

---

## 2. From-scratch bootstrap

Three pieces make a clean boot possible (`docs/architecture.md §7` for auth):

- **Signup replaces the manual SQL.** `apps/web/app/api/auth/signup/route.ts`
  creates the first `auth.users` row (bcrypt cost 12) and signs you in. It is
  open **only while `auth.users` is empty** — single-user, so the door closes
  after the first account (403 thereafter). `/login` renders **Create your
  account** when `countUsers() === 0`, otherwise the normal sign-in.
- **Zero-config owner resolution.** `ALLOWED_USER_ID` is now optional. The
  agent, the workers (`files-watch`, `docs-sync`), and the MCP server resolve
  the owner via `resolveSingleOwnerId()` / `waitForOwner()`
  (`packages/db/src/resolve-owner.ts`): the env var when set (validated as a
  UUID), else the sole `auth.users` row. Long-running workers **wait** for the
  first signup instead of exiting, so you can bring the stack up on an empty DB
  and they pick up the new owner with no restart.
- **Migrations run at start.** Dev `scripts/up.sh` runs `pnpm db:migrate`; prod
  runs a one-shot `migrate` service before any app service. Migrations replay
  from scratch (each in its own transaction). Nothing onboarding-specific needs
  a migration — it rides existing tables + `profiles.preferences` jsonb.

**Completion** is a single flag: `profiles.preferences.onboardedAt` (ISO).
Unset ⇒ the `(app)` shell redirects to `/onboarding`; set ⇒ the app renders
normally. Helpers in `apps/web/lib/onboarding.ts`
(`isOnboarded`/`markOnboarded`). The wizard lives **outside** the `(app)` group
so the gate can't loop. `preferences.onboardingStep` is a resume marker.

---

## 3. The wizard (`apps/web/app/onboarding/`)

Nine resumable steps. Each persists immediately through existing primitives, so
a refresh resumes from `onboardingStep`. Server work is in `actions.ts`; the
stepper is `onboarding-client.tsx`.

| # | Step | What it does |
|---|------|--------------|
| 1 | **Welcome** | timezone + locale (prefilled from the browser) → `updateProfilePreferences` |
| 2 | **OpenRouter key** (required) | the one required key — `setApiKey` + `testApiKeyAction` probe + link |
| 3 | **Voice** | works by default on the OpenRouter key (grok voice ara); optionally add a dedicated **xAI** key for a smoother voice route |
| 4 | **Set up** | `provisionDefaults(ownerId)` — creates the assistant + AI workers + the specialist stack (Pages/Ledger/Remy/Researcher/Coder, wired into Saskia's `delegate_to`) from the keys present |
| 5 | **Check** | `runSanityChecks()` — green/red list of the **vitals**: OpenRouter probe, xAI probe if added, embeddings, the assistant, **assistant capabilities** (tools + can-delegate + grounding/voice skills), **memory workers** (extractor/summarizer/reflector/document), **specialists & delegation** (Pages/Ledger/Remy/Researcher seeded + wired into `delegate_to` + their skills), **editor assistants** (`resolveAssistAgentSlug` for /pages + /tables), voice/images |
| 6 | **About you** | ~9 questions → one Life Log each (`createLifelog`); feeds the always-on identity block |
| 7 | **Personality** | preset bank × gender (voice) + name + creativity slider → `savePersonaAgent` |
| 8 | **Telegram** | optional/skippable — BotFather instructions + token via the shared `<TelegramBotSection>` (`connectAgentTelegram`) bound to the assistant agent. **Identical to the `/settings/agents` flow** (same component), so it can be done here or any time later in Settings → Agents. Needs the assistant to exist (step 4) first |

**Hybrid routing — why.** OpenRouter covers chat, memory indexing, image reading
(vision), image generation, AND voice (via the `openrouter-{tts,stt}` adapters,
default `x-ai/grok-voice-tts-1.0` voice `ara`) — so a **single OpenRouter key is
all you need**. Voice is the one capability where the aggregator is thinner
(limited speech routes; STT models aren't enumerable), so onboarding offers an
**optional dedicated xAI key** as a smoother voice route (grok voices ara/rex,
the proven path the production personas use). If the user adds it, voice runs on
xAI; if they skip it, voice falls back to OpenRouter — either way voice works.
The "Test" button reuses `testApiKeyAction`. The wizard is a guided front-end
over the same surfaces the settings pages use.

---

## 4. What gets provisioned (`apps/web/lib/onboarding-provision.ts`)

`provisionDefaults(ownerId)` is driven by which keys exist (idempotent — a
kind/slug that already exists is left alone):

| Capability | Worker kind | Provider · model | Gated by |
|---|---|---|---|
| Fact/summary/persona extraction | `extractor`, `summarizer`, `reflector` | OpenRouter · `google/gemini-3.1-flash-lite` | OpenRouter key |
| Document/PDF reading | `document` | OpenRouter · `google/gemini-3.1-flash-lite` | OpenRouter key |
| Image / scan reading | `vision` | OpenRouter · `google/gemini-3.1-flash-lite` | OpenRouter key |
| Image generation | `image_gen` | OpenRouter · `google/gemini-3.1-flash-image-preview` | OpenRouter key |
| Spoken replies | `tts` | xAI · `grok-voice-latest` (ara/rex) **or** OpenRouter · `x-ai/grok-voice-tts-1.0` (ara) | xAI key if added, else OpenRouter |
| Voice notes → text | `stt` | xAI · `grok-stt` **or** OpenRouter · `openai/gpt-4o-mini-transcribe` | xAI key if added, else OpenRouter |

All OpenRouter model picks above are operator-verified as working + affordable on
a single OpenRouter key. `gemini-3.1-flash-lite` is multimodal, so it backs the
indexing workers, document reading, and vision alike.
| Memory search | embeddings | local EmbeddingGemma (no key, 768-dim) | always |

The **assistant** is one `agents` row (slug `assistant`, role `responder` — serves
both web `/assistant` and Telegram), model `anthropic/claude-sonnet-4.6`, with
`inject_lifelog: true`. It's created with the Warm/Saskia default and refined by
the personality step (`savePersonaAgent`: rebuilds the system prompt from the
chosen preset, sets the name + temperature, points the TTS voice at the gender).

> **Vital linkage — tools + skills (not just rows).** A provisioned agent that
> has no `tool_slugs` can't act (no search, no capture, no delegation), and one
> without the shared behaviour skills answers from memory instead of the user's
> data — both look "set up" but are broken. So provisioning also:
> - seeds the builtin tool **rows** (`seedBuiltinTools`) and grants the assistant
>   `DEFAULT_ASSISTANT_TOOL_SLUGS` (from `@mantle/tools`) — the proven generalist
>   set (broad memory/CRUD + media + `invoke_agent`), minus the specialist/
>   dangerous tools (raw shell, destructive deletes, the `table_*` grid tools →
>   delegate to Ledger, `web_search`/`find_window` → delegate to Researcher/Remy,
>   federation). Re-running the wizard **repairs** a toolless assistant.
> - attaches the shared behaviour skills (`tool_grounding`, `voice_reply`,
>   `rich_writing`) to the assistant — done by `applyManifest`'s persona-skill
>   attach (the manifest persona's `skillSlugs`). The CLI `seed:shared-skills`
>   additionally wires Alex's named personas `telegram-default`/`apostle-paul`,
>   which don't exist on a fresh brain.
>
> Skills attach to **agents only** — `ai_workers` have no skill column; their
> behaviour is the model + an optional `system_prompt`.

### Specialist stack (seeded alongside the persona)

A lone assistant isn't enough — Saskia delegates to specialists, and the `/pages`
and `/tables` editor **Assist** panels invoke them directly. So when an OpenRouter
key is present, `provisionDefaults` runs `seedSpecialistStack(ownerId)`, which
seeds the shared skills first (`page_editing`/`tool_grounding`/`voice_reply`,
`rich_writing`, `table_authoring`) then the specialist agents:

| Agent (slug) | Role | Why |
|---|---|---|
| **Pages** (`pages`) | document authoring/editing | backs the `/pages` Assist panel; Saskia delegate |
| **Ledger** (`tables`) | typed-grid/data | backs the `/tables` Assist panel; Saskia delegate |
| **Remy** (`remy`) | memory recall | Saskia delegate (`find_window` → `recall_window`) |
| **Researcher** (`researcher`) | web search | Saskia delegate (Perplexity Sonar) |
| **Coder** (`coder`) | code specialist | responder; delegates to pages/tables |

These are seeded from the **system manifest** (`apps/web/lib/system-manifest/`) —
the single declarative source of truth for the agent/skill/tool/worker graph, with
a CI drift-test (`manifest.test.ts`) and a standing live checker
(`checkSystemIntegrity`, surfaced at `/debug/integrity` → System config).
`seedSpecialistStack` calls `applyManifest(ownerId)`, which seeds the skills, upserts the specialist
agents, wires each delegate specialist into every enabled responder/assistant's
`memory_config.delegate_to`, and attaches the persona's behaviour skills — all
idempotent + **gap-fill** (re-running the wizard never clobbers an operator's
customised prompt/model/params). The `pnpm -C apps/web seed:*` CLIs are thin
wrappers over the same `applyManifest` (with `mode: 'overwrite'`), so the wizard,
the CLI, and the integrity checker can't drift. Successes are listed back in the
wizard's Set-up step (`ProvisionResult.seededSpecialists`).

> **Configurable Assist binding.** Which agent a surface's Assist panel invokes
> is **not** a hardcoded slug. The `/pages` and `/tables` editors each carry an
> agent picker in the Assist panel header (`components/assist-agent-picker.tsx`)
> that writes `profiles.preferences.{pagesAssistAgentSlug,tablesAssistAgentSlug}`
> via `POST /api/profile/assist-agent`. The ai-assist routes resolve the agent
> through `resolveAssistAgentSlug(ownerId, surface)` (`lib/assist-agent.ts`):
> saved preference → the default `pages`/`tables` specialist → a friendly 409 if
> neither exists (instead of a raw `invokeAgent` 500). So the operator can point
> Assist at any of their agents, and the panels degrade gracefully pre-seed.

> **Embeddings need a local embedder.** Memory search (vector recall) uses local
> EmbeddingGemma — no key, but it needs an Ollama serving it. The **prod**
> compose (`docker-compose.yml`) bundles `ollama` + a one-shot model pull, so a
> containerized deploy is covered. For **local dev**, `docker-compose.dev.yml`
> does NOT bundle Ollama — run one (`ollama serve` + `ollama pull embeddinggemma`,
> or point `MANTLE_LOCAL_EMBEDDING_URL` at an existing instance). The onboarding
> **sanity check** flags this clearly if the embedder is unreachable. The
> assistant and the always-on identity block work without it — only semantic
> search degrades until the embedder is up.

---

## 5. The personality bank (`packages/content/src/persona-bank.ts`)

Browser-safe presets derived from Saskia's real persona — **Warm** (the
default), **Professional**, **Playful**, **Concise** — each available
female/male. `buildPersonaPrompt(preset, { assistantName, gender })` renders the
system prompt; the user's name comes from the always-on Life Log identity block,
so the prompt stays name-agnostic. Voice maps to gender (female `ara`, male
`rex`, matching prod). The creativity slider is the same `temperature` control
as the agent editor.

---

## 6. The interview (`packages/content/src/onboarding-questions.ts`)

~9 ordered questions (name, nickname, partner, family, work, faith, health,
interests, goals, free catch-all). `composeBody` turns each answer into a
first-person Life Log under a life-area category; the nickname (or first name)
also becomes `preferences.displayName`. Those entries feed
`buildIdentityContext` → the `# About the user (Life Log)` block injected into
every agent turn, so the assistant knows who you are from the first message. See
[`lifelog.md`](./lifelog.md).

---

## 7. Files

- **New:** `apps/web/app/api/auth/signup/route.ts`, `apps/web/lib/onboarding.ts`,
  `apps/web/lib/onboarding-provision.ts`, `apps/web/app/onboarding/*`,
  `packages/db/src/resolve-owner.ts`, `packages/content/src/persona-bank.ts`,
  `packages/content/src/onboarding-questions.ts` (+ tests).
- **Modified:** `apps/web/app/login/*` (first-run mode), `apps/web/app/(app)/layout.tsx`
  (gate), `apps/agent/src/main.ts` + `apps/web/workers/{files-watch,docs-sync}.ts`
  + `apps/mcp/src/server.ts` (wait-for-owner), `packages/content/src/profile-preferences.ts`
  (displayName/onboardedAt/onboardingStep), env examples.
