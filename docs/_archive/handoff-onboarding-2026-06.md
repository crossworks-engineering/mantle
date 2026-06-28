# Handover — First-run onboarding (June 2026)

Status at handover: **code complete, all tests green, on `main`.** Jason is about
to **live-test the wizard screens** end-to-end. Durable reference is
[`docs/onboarding.md`](../onboarding.md); this file is the "where we are / how to
continue" note.

## What shipped

A brand-new Mantle clone now boots into a working brain with **no SQL and no env
editing**: `pnpm up` → open the browser → **Create your account** → an 8-step
wizard → a fully working assistant on **a single OpenRouter key**.

16 commits on `main`, `a7ef458` → `f5b7fb0` (base `98c02ca`). Two phases:

- **Phase 1 — from-scratch bootstrap + wizard.**
  - Signup `apps/web/app/api/auth/signup/route.ts` (open only while `auth.users`
    is empty; atomic `INSERT…WHERE NOT EXISTS`; case-insensitive login). `/login`
    renders "Create your account" on first run (`apps/web/app/login/*`).
  - `ALLOWED_USER_ID` is **optional** — `packages/db/src/resolve-owner.ts`
    (`resolveSingleOwnerId` / `waitForOwner` / `countUsers`). The agent
    (`apps/agent/src/main.ts`), `files-watch`, `docs-sync`, and the MCP server
    resolve the sole user and **wait** for first signup instead of exiting.
  - Onboarding gate on `profiles.preferences.onboardedAt`
    (`apps/web/lib/onboarding.ts`); `isOnboarded` also treats an existing install
    (has an enabled agent) as onboarded + lazily stamps, so a populated stack is
    never dragged into the wizard. Gate in `apps/web/app/(app)/layout.tsx`. The
    wizard lives OUTSIDE the `(app)` group. **`/onboarding?force=1`** re-enters
    the wizard on a populated stack (for testing).
  - Wizard `apps/web/app/onboarding/` (`page`/`layout`/`onboarding-client.tsx` +
    `actions.ts`): profile → OpenRouter key → Voice → provision → sanity → ~9-Q
    interview → personality → Telegram → done. Resumable via `onboardingStep`.
  - Content modules (browser-safe leaves):
    `packages/content/src/persona-bank.ts` (presets × gender) +
    `onboarding-questions.ts` (interview → Journal → identity block).

- **Phase 2 — one OpenRouter key for everything.**
  - New adapters `packages/voice/src/adapters/openrouter-{tts,stt,image}.ts`
    (registered; added to `WIRED_PROVIDERS` + `providers.ts` capabilities).
  - Onboarding collapsed to ONE required OpenRouter key; voice is an optional
    **xAI** upgrade (falls back to OpenRouter when no xAI key).

## THE BASELINE (operator-verified, don't change without re-testing)

`apps/web/lib/onboarding-provision.ts` — one OpenRouter key provisions:

| Kind | Model |
|---|---|
| extractor / summarizer / reflector / **document** / **vision** | `google/gemini-3.1-flash-lite` (multimodal — one cheap model) |
| image_gen | `google/gemini-3.1-flash-image-preview` |
| tts | `x-ai/grok-voice-tts-1.0` (voice **ara**, rex for male) |
| stt | `openai/gpt-4o-mini-transcribe` |
| chat / persona | `anthropic/claude-sonnet-4.6` |
| embeddings | local EmbeddingGemma (768) |

Adding an **xAI** key upgrades voice to dedicated `grok-voice-latest` /
`grok-stt`. These are the exact models Jason tested and approved.

## Known constraints (important, don't re-discover)

- **OpenRouter `/audio/speech` only works for `x-ai/grok-voice-tts-1.0`.** The
  other OR "speech" models (mai-voice → 400, gemini-tts/zonos/kokoro/… → 500)
  are chat-modality audio models, not OpenAI-compatible `/audio/speech`. TTS
  discovery is therefore curated to a grok-voice allowlist
  (`WORKING_AUDIO_SPEECH_MODELS` in `openrouter-tts.ts`). Want more OR voices →
  implement the chat-completions+modalities path.
- **OR STT models aren't in `/v1/models`** (reachable only via
  `/audio/transcriptions`, like embeddings) → STT uses a curated list.
- **Dev embeddings need Ollama.** Prod compose bundles it; `docker-compose.dev.yml`
  does NOT — run `ollama serve` + `ollama pull embeddinggemma` or set
  `MANTLE_LOCAL_EMBEDDING_URL`. The sanity step flags it. (Open decision: bundle
  Ollama in the dev compose? Deferred.)
- **Stale `.next` typecheck noise:** the main checkout's `.next/types` references a
  long-deleted `settings/senders` route → 2 phantom `tsc` errors. Runtime is
  fine; `rm -rf apps/web/.next` clears it. Filter `| grep -v senders` when
  typechecking.
- Browser-safe leaf rule: client code imports `@mantle/content/persona-bank` /
  `/onboarding-questions` (subpaths), NOT the `@mantle/content` barrel (it pulls
  `@mantle/db` → postgres into the bundle).

## Test environment — `~/Projects/mantle-new`

An **isolated** clone so the real dev brain (`mantle_pg:54323`) is never touched:
compose project `mantlenew`, postgres `:55432`, web `:3100`, own volume
(`docker-compose.test.yml` — local only, not committed). `apps/web/.env.local`
points `DATABASE_URL` at `:55432`, `ALLOWED_USER_ID` blank.

- Reset to a pristine brain:
  `cd ~/Projects/mantle-new && docker compose -f docker-compose.test.yml down -v && docker compose -f docker-compose.test.yml up -d --wait && pnpm -C packages/db migrate`
- Run: `PORT=3100 pnpm -C apps/web dev` + `pnpm -C apps/agent dev`.
- Pull latest: `git -C ~/Projects/mantle-new pull --ff-only` (origin is the local
  `~/Projects/mantle`).

## Verified vs. pending

- ✅ Unit: 1226 tests green (incl. new adapter request/response tests + persona
  bank + interview). All packages typecheck (modulo the senders `.next` noise).
- ✅ Live on a clean brain: signup, gate, owner pickup (agent boots on empty DB
  then resolves the new user with no restart), interview → identity block.
- ✅ Adapter slugs verified against OpenRouter's live `/models` API.
- ⏳ **Next (Jason):** walk the full wizard screens with a real key — provision,
  sanity-check greens, personality, and the live TTS/STT/image calls in
  `/traces`. Confirm the OpenRouter voice (grok ara) + transcription + image-gen
  end-to-end through the UI.

## Workflow notes

- All work is on `main` (worktree `claude/great-bassi-46f8bd` kept in sync via
  ff-merge). Nothing pushed to a remote unless Jason asks.
- No new DB migration was needed (everything rides existing tables +
  `profiles.preferences` jsonb).
- Power users keep dedicated providers (xAI/OpenAI/ElevenLabs/…) in
  `/settings/ai-workers` — onboarding just defaults to the one-key set.
