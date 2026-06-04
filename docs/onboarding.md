# Onboarding — from a clean brain to a working assistant

> A fresh Mantle clone boots into a working brain with **no SQL and no env
> editing**: clone → `pnpm up` → open the browser → create an account → walk a
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
| 2 | **Your key** (required) | a single OpenRouter key — `setApiKey` + `testApiKeyAction` probe + link to get one |
| 3 | **Voice & images** | keyless opt-in toggle — turns on tts/stt/vision/image_gen on the SAME OpenRouter key |
| 4 | **Set up** | `provisionDefaults({enableVoiceImage})` — creates the assistant + AI workers |
| 5 | **Check** | `runSanityChecks()` — a green/red list (the key probes, embeddings, the agent, voice/images) |
| 6 | **About you** | ~9 questions → one Life Log each (`createLifelog`); feeds the always-on identity block |
| 7 | **Personality** | preset bank × gender (voice) + name + creativity slider → `savePersonaAgent` |
| 8 | **Telegram** | optional — BotFather instructions + token (`connectAgentTelegram`); skippable |

**One key for everything.** OpenRouter now exposes audio (`/audio/speech`,
`/audio/transcriptions`) and image generation (chat `modalities`), and Mantle
routes chat/vision/embeddings through it already — so a single OpenRouter key
powers chat, memory, voice in/out, image reading, and image generation (the
`openrouter-{tts,stt,image}` adapters in `@mantle/voice`). The "Test" button
reuses `testApiKeyAction` (a no-cost `/v1/models` probe). Nothing here is bespoke
storage — the wizard is a guided front-end over the same surfaces the settings
pages use, where power users can still add xAI/OpenAI/etc. providers directly.

---

## 4. What gets provisioned (`apps/web/lib/onboarding-provision.ts`)

`provisionDefaults(ownerId, {enableVoiceImage})` creates everything on the single
OpenRouter key, idempotently (a kind/slug that already exists is left alone). The
voice/image kinds are created only when the toggle is on:

| Capability | Worker kind | Provider · model | Gated by |
|---|---|---|---|
| Fact/summary/persona extraction | `extractor`, `summarizer`, `reflector` | OpenRouter · `google/gemini-3.1-flash-lite` | always |
| Document/PDF reading | `document` | OpenRouter · `x-ai/grok-4.3` | always |
| Voice notes → text | `stt` | OpenRouter · `openai/whisper-large-v3` | voice/image toggle |
| Image / scan reading | `vision` | OpenRouter · `openai/gpt-4o-mini` | voice/image toggle |
| Spoken replies | `tts` | OpenRouter · `openai/gpt-4o-mini-tts` (voice per gender: nova/onyx) | voice/image toggle |
| Image generation | `image_gen` | OpenRouter · `google/gemini-3.1-flash-image-preview` | voice/image toggle |
| Memory search | embeddings | local EmbeddingGemma (no key, 768-dim) | always |

The **assistant** is one `agents` row (slug `assistant`, role `responder` — serves
both web `/assistant` and Telegram), model `anthropic/claude-sonnet-4.6`, with
`inject_lifelog: true`. It's created with the Warm/Saskia default and refined by
the personality step (`savePersonaAgent`: rebuilds the system prompt from the
chosen preset, sets the name + temperature, points the TTS voice at the gender).

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
