# Handover — onboarding hardening + system integrity (June 2026)

A single session that took onboarding from "provisions rows" to "provisions a
*working, verifiable* system", and introduced a single source of truth for the
agent/skill/tool/worker graph. Everything is on `main` and ff-merged; the dev
stack (`~/Projects/mantle`, `:54323`) runs it.

Durable reference: [`docs/system-integrity.md`](../system-integrity.md) +
[`docs/onboarding.md`](../onboarding.md). This is the "what we did / where we are"
note.

## Commits (this session, on `main`)

| commit | what |
|---|---|
| `341eb38` | onboarding seeds the specialist stack (Pages/Ledger/Remy/Researcher/Coder + skills + delegate_to); `/pages`·`/tables` Assist agent made **configurable** on the surface (picker → `profiles.preferences.{pages,tables}AssistAgentSlug`; routes resolve via `resolveAssistAgentSlug` → 409 not 500) |
| `5a96bcd` | fix: `/settings/agents` double scrollbar — Radix Switch bubble-inputs escaped the detail pane's clip; made the pane a containing block (`relative`). Root-caused + verified live (main.scrollHeight 9481→945) |
| `7d5bbaa` | onboarding Telegram step reuses the agents bot **connect→pair** flow (shared `TelegramBotSection`, same `/api/agents/[id]/telegram` routes); was token-only before, no pairing |
| `03130c5` | the **vitals**: assistant was created with EMPTY tool_slugs (couldn't act/delegate) and never got `tool_grounding`/`voice_reply` → `DEFAULT_ASSISTANT_TOOL_SLUGS` (68 tools) in `@mantle/tools` + skill attach + repair-on-rerun; onboarding Check verifies them |
| `c683825` | **system integrity Phase 1**: declarative manifest + CI drift-test + `checkSystemIntegrity` + `/debug/integrity` "System config" tab; onboarding Check sources from it (one source of truth) |
| `4c0c2a8` | **system integrity Phase 2**: manifest is the **seeding** source — `prompts.ts` (verbatim bodies) + `applyManifest` seeder (gap-fill/overwrite); onboarding + the 8 CLI `seed:*` scripts are thin wrappers. Net −603 LOC |
| `f84f0f9` | fix: System config tab re-fetch loop (auto-run effect keyed on an unmemoized `toast` ref → mount-once) |

(`adac921`/`4ae9786` — Jason's versioning/release commits — landed interleaved; rebased onto cleanly.)

## The shape now

- **Manifest** = `apps/web/lib/system-manifest/` is the single source of truth for
  the default `assistant` persona + `pages`/`tables`/`remy`/`researcher`/`coder`
  specialists + their skills + delegation + editor-Assist bindings + worker kinds.
- **Three consumers:** the CI drift-test (`manifest.test.ts`), the `applyManifest`
  seeder (onboarding + CLI), and the `checkSystemIntegrity` checker (`/debug` tab +
  onboarding Check). See `docs/system-integrity.md`.
- **Operator personas** (`telegram-default`/Saskia, `apostle-paul`) are NOT manifest
  slugs — never seeded/clobbered.

## Verified this session

- ✅ Typecheck clean; **1238 tests** green (incl. new manifest drift-test +
  default-tool-grant test). The drift-test was proven to FAIL on an injected bogus
  slug, then revert clean.
- ✅ `/settings/agents` double-scrollbar fix verified live in-browser.
- ✅ `/debug/integrity` System tab verified live; loop fix verified (0 fetches over
  6s idle).
- ✅ Telegram `TelegramBotSection` extraction verified live on the agents page.
- ✅ **`applyManifest` end-to-end on a real brain:** ran `pnpm -C apps/web seed:coder`
  on the dev brain → `coder` gained `mantle-ops`, aligned to role `custom`, and both
  personas now delegate to `coder`. The integrity check's "Agent ↔ skill links" went
  green (problems 3→2).
- CLI `tsx` resolution confirmed (scripts import the seed module by relative path —
  the `@/` alias doesn't resolve under tsx).

## Dev-brain note (not a bug)

The dev brain (`:54323`) was hand-built before onboarding existed, so its persona is
`telegram-default` (Saskia), not the manifest's canonical `assistant`. The System
tab therefore shows **2 honest reds** — "Persona agent (assistant)" + "Delegation
wiring" — because it measures against slug `assistant`, which isn't present. A
freshly **onboarded** brain creates slug `assistant` and reads fully green. Nothing
is broken on the dev brain; the checker is measuring against the canonical.

## What's left / next

- **Jason's fresh onboarding run** (`~/Projects/mantle-new`, pg `:55432`, web `:3100`)
  is the real end-to-end: walk the wizard with a real OpenRouter key, confirm the
  Check step is all-green (incl. the manifest specialists), the Telegram pairing, and
  the live TTS/STT/image calls. `applyManifest` will create the specialists from
  scratch there.
- **Phase 2 follow-on (optional):** the heartbeat-tools-not-registered-in-web seeding
  gap (documented in `system-integrity.md §6`) — register heartbeat tools in the web
  seed path if we ever want the persona to hold them by default.
- **Optional polish:** (a) memoize the toast provider's `api` object (latent footgun
  for any future auto-run+toast component); (b) make the persona check slug-flexible
  (treat any enabled responder as the persona when no `assistant` exists) so
  hand-built brains read green.
- **PROD:** none of this needs a migration (rides existing tables). Standard deploy.
