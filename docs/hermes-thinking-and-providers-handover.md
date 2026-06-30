# Handover — Thinking + GitHub Copilot provider (learning from Hermes)

**Branch:** `feat/real-thinking` (worktree `.claude/worktrees/real-thinking`), UNMERGED.
**Date:** 2026-06-29.
**Source studied:** NousResearch **Hermes** (`~/Projects/mantle/hermes-agent`, a Python agent).

## TL;DR

We studied Hermes to improve Mantle's "thinking / narrate-next-step / streaming",
and shipped two intertwined things on one branch:

1. **Real model thinking** end-to-end — request it, stream it, surface it, and
   keep it correct across a tool round-trip — replacing the canned "thinking
   phrases" theatre.
2. **A new direct provider, GitHub Copilot**, with reasoning — modelled on how
   Hermes implements its `copilot` provider.

Seven commits, 325 voice tests green. Default-OFF behind a gate
(`MANTLE_THINKING_BUDGET`) pending a live smoke test (see §6).

---

## 1. Background & goal

Jason asked us to study Hermes (very popular OSS agent) for what it does well on
**thinking + streaming**, and to "add robustness learning from the community."
Two threads came out of it:

- **Thinking pipeline.** Mantle already had the *plumbing* to stream model
  reasoning (`reasoning-delta` events → NOTIFY → SSE → web client) but it was
  **starved at both ends**: we never *requested* thinking from the provider, and
  the web client *discarded* any reasoning that did arrive. What the user saw was
  100% synthetic — a rotating list of canned phrases ("Mulling it over…") plus a
  separate gemini-flash "narrator" restyling tool labels. Jason's words: "our
  model is broken."
- **Providers.** Hermes supports many providers directly; Jason asked us to
  "follow Hermes' lead and add another copilot direct adapter with thinking."

---

## 2. Where the providers live in Hermes

Hermes keeps per-provider logic in a few places. The **Copilot** provider is the
one we ported, so it's documented in most detail.

### 2.1 Provider plugin layout

```
hermes-agent/plugins/model-providers/copilot        # the GitHub Copilot provider
hermes-agent/plugins/model-providers/copilot-acp     # an ACP-transport variant (not ported)
hermes-agent/hermes_cli/copilot_auth.py              # token exchange + request headers
hermes-agent/hermes_cli/models.py                    # default headers, model filtering, API-mode
hermes-agent/hermes_cli/auth.py                      # base URLs
hermes-agent/run_agent.py                            # provider routing + credential refresh
```

How we found it: `grep -rniE "copilot" hermes-agent` →
`find hermes-agent -iname "*copilot*"`.

### 2.2 Copilot — the wire details we ported

**Base URL** — `hermes_cli/auth.py:92`:

```python
DEFAULT_GITHUB_MODELS_BASE_URL = "https://api.githubcopilot.com"
DEFAULT_COPILOT_ACP_BASE_URL  = "acp://copilot"   # the ACP variant — we ignored this
```

`run_agent.py:1118` confirms the host check: `hostname == "api.githubcopilot.com"`.
Chat is the OpenAI-compatible `/chat/completions` under that host.

**Auth = token exchange, not a static key.** Copilot authenticates with a
SHORT-LIVED Copilot token minted from a GitHub OAuth token. Hermes does this in
`hermes_cli/copilot_auth.py` (`resolve_copilot_token()`), and refreshes it on
credential failure (`run_agent.py:3986 _try_refresh_copilot_client_credentials`,
`:3998 from hermes_cli.copilot_auth import resolve_copilot_token`). The exchange
endpoint is GitHub's `copilot_internal/v2/token` (the well-known VS Code /
opencode flow).

**Editor headers required on every request** — `copilot_auth.py:377-396`
(`copilot_request_headers`) and `models.py:2768` (`copilot_default_headers`):

```python
headers = {
    "Editor-Version": "vscode/1.104.1",
    "User-Agent": "HermesAgent/1.0",
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Intent": "conversation-edits",
    "x-initiator": "agent" if is_agent_turn else "user",
}
if is_vision:
    headers["Copilot-Vision-Request"] = "true"
```

The docstring notes this "replicates the header set used by opencode and the
Copilot CLI" — i.e. Copilot 4xxs without the editor fingerprint.

**Model discovery + filtering** — `models.py:2786 _copilot_catalog_item_is_text_model`
drops entries where `model_picker_enabled is False` or `capabilities.type != "chat"`
(the `/models` list also includes embeddings / non-chat models). `cli.py:5022`
+ `models.py` handle model-id normalisation and per-model API mode
(`copilot_model_api_mode`, `_should_use_copilot_responses_api` — chat completions
vs the OpenAI Responses API; we only needed chat completions).

### 2.3 Thinking machinery we also drew on (context)

The same study informed the thinking work (documented fully in the memory note
`hermes-thinking-learnings.md`). The most relevant Hermes pieces:

- `agent/think_scrubber.py` — `StreamingThinkScrubber`, a stateful, delta-boundary
  -aware filter for inline `<think>…</think>` that open/local models emit in the
  *content* stream. We ported this (commit `464c27a1`).
- Native reasoning fields + **echo-back** — Hermes preserves provider reasoning
  (`reasoning` / `reasoning_content`) and replays it on continuation so providers
  (DeepSeek/Kimi/Anthropic) don't reject a replayed tool turn. This is the
  pattern behind our OpenRouter `reasoning_details` round-trip (commit `4d6c6e4e`)
  and the direct-provider continuation guard (commit `a90dcf71`).

---

## 3. How we implemented it in Mantle

All in `packages/voice` (the adapter framework) + `packages/agent-runtime`
(tool loop) + `apps/web` (the live trail). Commit map:

| Commit | What |
|---|---|
| `464c27a1` | Port Hermes' `StreamingThinkScrubber` → strip inline `<think>` across all open/local adapters |
| `b26f99d0` | `ChatOptions.thinkingBudget`; Anthropic `thinking:{adaptive,summarized}`; OpenRouter `reasoning:{max_tokens}` (inert) |
| `4d6c6e4e` | OpenRouter `reasoning_details` capture + replay across tool rounds (the echo-back) |
| `7e802464` | Gate: `MANTLE_THINKING_BUDGET` injects thinking into the tool loop (dark by default) |
| `8c104140` | Web: surface real reasoning as a collapsible "Thinking" trace; retire the canned phrases |
| `a90dcf71` | Direct-Anthropic continuation guard; wire Gemini native `thinkingConfig` |
| `bb051fb5` | **New GitHub Copilot provider** with reasoning |

### 3.1 Thinking architecture (source → capture → sink)

- **Source (request it).** Each adapter translates `opts.thinkingBudget` to its
  provider's knob: Anthropic `thinking:{type:'adaptive', display:'summarized'}`
  (the modern API — the old `budget_tokens` 400s on Opus 4.7/4.8/Fable);
  OpenRouter `reasoning:{max_tokens}`; Gemini `generationConfig.thinkingConfig`;
  Copilot `reasoning_effort`. Sampling params are dropped when thinking is on
  (reasoning models reject them). `display:'summarized'` is **required** or
  Anthropic streams empty thinking text.
- **Capture / continuity (the hard part).** Thinking + tool use needs the signed
  reasoning blocks replayed on the next request, or the provider 400s. The
  responder routes through **OpenRouter**, whose continuity uses signed
  `reasoning_details`. `ReasoningDetailsAccumulator`
  (`packages/voice/src/adapters/reasoning-accum.ts`) reassembles streamed
  fragments by index (signature-exact), `ChatResult.reasoningDetails` /
  `ChatAssistantMessage.reasoningDetails` carry them, the tool loop stores them
  on the assistant turn, and `buildMessages` re-emits them.
- **Sink (show it).** `apps/web/components/assistant/use-turn-stream.ts` now
  *accumulates* `reasoning-delta` instead of discarding it; `thought-trail.tsx`
  renders a collapsible "Thinking" disclosure. `stage-label.ts` retired the
  20-phrase rotation for a single honest "Thinking…". Reasoning is ephemeral
  (never persisted).
- **Gate.** `MANTLE_THINKING_BUDGET` (int tokens, >0 = on) in the tool loop,
  per box. Shipped **dark** — the signature round-trip can only be proven against
  a live OpenRouter+Anthropic call.

### 3.2 The GitHub Copilot provider (commit `bb051fb5`)

Followed Mantle's 5-step provider cookbook (`docs/adding-a-provider.md`). Files:

| Step | File | Notes |
|---|---|---|
| Catalogue | `packages/voice/src/providers.ts` | `ProviderId` union + `SUPPORTED_PROVIDERS` entry, capabilities `['chat']` |
| Static catalog | `packages/voice/src/catalogs/copilot.ts` | `COPILOT_BASE_URL` + curated reasoning models; live discovery refines |
| Auth | `packages/voice/src/adapters/copilot-auth.ts` | **the Hermes port** — token exchange + editor headers |
| Adapter | `packages/voice/src/adapters/copilot-chat.ts` | openai-compat chat/stream + `reasoning_effort` |
| Register | `packages/voice/src/adapters/index.ts` + `registry.ts` | `registerChatAdapter` + `WIRED_PROVIDERS.chat` |
| Tests | `packages/voice/src/adapters/copilot-chat.test.ts` | 7 wire-shape tests |

**Auth (`copilot-auth.ts`)** mirrors Hermes' `copilot_auth.py`:

- `copilotHeaders()` sends the exact editor fingerprint
  (`Editor-Version: vscode/1.104.1`, `Copilot-Integration-Id: vscode-chat`,
  `Openai-Intent`, `x-initiator: agent`, `User-Agent`).
- `resolveCopilotToken(key)` exchanges a GitHub OAuth token at
  `https://api.github.com/copilot_internal/v2/token` (`Authorization: token …`)
  for the Copilot bearer, **caches per OAuth token until `expires_at` − 120 s**,
  coalesces concurrent exchanges, and force-re-mints on a 401. A key that already
  contains `tid=` (a pre-minted Copilot token) is used verbatim.

**Adapter (`copilot-chat.ts`)** reuses the shared `openai-compat.ts` translation
+ streamer (so it inherits the `<think>` scrubber and `reasoning_content`
forwarding for free), adds the Copilot bearer + editor headers, and a one-shot
re-mint on 401 (`withCopilotAuth`). **Thinking:** `copilotReasoningEffort()` maps
`thinkingBudget` → `reasoning_effort` (`<2000`→low, `<8000`→medium, else high),
drops sampling params when on, and requests reasoning **every round** — Copilot's
chat-completions reasoning is server-side (no signed blocks to replay), so it
needs no continuation guard, unlike direct Anthropic/Gemini.

**Discovery** hits `GET /models` with the Copilot headers and filters out
`model_picker_enabled === false` / non-chat `capabilities.type` (the same filter
Hermes applies in `models.py`).

---

## 4. Per-provider thinking support

| Provider | How it requests thinking | Continuity | Net under the gate |
|---|---|---|---|
| **OpenRouter** (responder path; umbrella for Anthropic/OpenAI/Gemini-via-OR) | `reasoning:{max_tokens}` | `reasoning_details` echo-back | **Full — thinks every round** |
| **GitHub Copilot** (new) | `reasoning_effort` | server-side (none needed) | **Full — thinks every round** |
| **Anthropic (direct)** | `thinking:{adaptive,summarized}` | continuation guard (no echo-back) | First round thinks; continuations run thinking-off (no 400) |
| **Google Gemini (direct)** | `thinkingConfig{thinkingBudget,includeThoughts}` | continuation guard | First round thinks; thought parts → reasoning channel |
| **xAI / HuggingFace / DeepSeek / local** | — | — | Inert (ignore the budget; won't break) |

The **continuation guard** (`packages/voice/src/adapters/thinking-guard.ts`,
`wantGuardedThinking` / `isToolContinuation`): for echo-back-less providers,
request thinking only when the history has no prior assistant `tool_use` turn.
The first round still thinks (incl. the round that calls a tool); continuations
run thinking-off, which makes the replayed thinking-less history valid.

---

## 5. Verification

- **Green:** typecheck across `@mantle/voice` / `@mantle/agent-runtime` /
  `@mantle/assistant-runtime` / `@mantle/web`; 325 voice unit tests including the
  scrubber split-delta case, the reasoning-details accumulator (signature-exact),
  the continuation guard, and the 7 Copilot wire-shape tests; catalog-consistency
  + registry-drift gates pass.
- **NOT proven by unit tests:** the live signature round-trip (OpenRouter →
  Anthropic, thinking + tools), and the in-browser reasoning trace. Both need a
  running stack with provider keys and the gate on — that's the §6 smoke test.

---

## 6. How to enable / operate

**Thinking (per box):**

1. Set `MANTLE_THINKING_BUDGET=2000` (any int > 0) in the apps/api environment.
2. Restart the apps/api runner.
3. Ask the responder something that triggers a tool call (so it thinks *then*
   calls a tool → exercises echo-back on round 2).
4. Confirm: no 400 on round 2, and the live "Thinking" disclosure shows real
   reasoning text.
5. Clean → make it the per-box default (and revisit on-by-default).

**GitHub Copilot worker:**

- In Settings → AI workers, pick provider **GitHub Copilot**, choose a model.
- The "API key" is a **GitHub Copilot OAuth token** (the device-flow `gho_…`
  that VS Code / the Copilot CLI obtains) — **not** a PAT. Only the OAuth token
  carries the `copilot_internal` scope the token-exchange needs. A pre-minted
  Copilot token (`tid=…`) also works but expires in ~25 min.
- Thinking on a Copilot worker is controlled by the same `MANTLE_THINKING_BUDGET`
  gate (it maps to `reasoning_effort`).

---

## 7. Follow-ups

- **Promote thinking from dark → default** once the live smoke test is clean.
- **Merge:** `#1` (the scrubber, `464c27a1`) is independently safe to merge now;
  the rest waits on the smoke test.
- **Direct-Anthropic / Gemini every-round thinking** — would need their own
  block/signature echo-back (only matters if a box runs a *direct*-provider
  responder; today the responder is OpenRouter). See the scoped enhancement
  below.

### 7.1 Future enhancement — native direct-Anthropic thinking-block echo-back

**Status:** documented, UNBUILT. Low priority — only relevant if a box's
responder is configured to use the **direct** `anthropic` provider instead of
OpenRouter. Today the direct path thinks on round 0 only (the
[`thinking-guard`](../packages/voice/src/adapters/thinking-guard.ts) disables
thinking on tool continuations because we don't replay the signed block). This
enhancement makes the direct path think on *every* round, matching OpenRouter.

**Why it's now well-understood (the contract is verified, not a guess).** Checked
against the `claude-api` skill: a thinking-then-tool_use turn must replay the
prior `thinking` block **exactly as received** on the same model — *the API
rejects modified blocks, not read ones*. Critically, `display:'summarized'`
(and even `display:'omitted'`, which yields empty thinking text) still produces a
**replayable block**: you capture the block with its `signature` and re-send it
verbatim; the signature validates the block-as-delivered, not the hidden raw
reasoning. So summarized display and block replay compose cleanly — there is no
"we only have the summary but the signature wants the full thing" failure mode.
`redacted_thinking` blocks (encrypted; carry a `data` field instead of text) must
be captured and replayed the same way.

**Approach — reuse the existing `reasoningDetails` channel; one file.** The
per-assistant-message `reasoningDetails` carry + replay plumbing already exists
and is proven by OpenRouter, and `ReasoningDetail`
(`packages/voice/src/adapters/types.ts`) is loose enough (`type`/`text`/`data`/
`signature`) to hold native Anthropic blocks. So **no tool-loop or runtime
changes** are needed — only [`anthropic-chat.ts`](../packages/voice/src/adapters/anthropic-chat.ts):
1. **Capture (one-shot):** also collect `thinking` (text + `signature`) and
   `redacted_thinking` (`data`) blocks off `parsed.content` into
   `ChatResult.reasoningDetails`.
2. **Capture (streaming):** extend the `blocks` Map to handle `content_block_start`
   type `thinking`/`redacted_thinking`, accumulate `thinking_delta`, and capture
   the **`signature_delta`** event (currently ignored by the streamer).
3. **Replay:** in `splitSystemAndMessages`, when an assistant turn carries
   `reasoningDetails`, prepend reconstructed `thinking`/`redacted_thinking`
   blocks **before** the text and `tool_use` blocks (Anthropic requires the
   signed block first in the turn).
4. **Guard:** swap `wantGuardedThinking(opts)` → plain `budget > 0` for Anthropic
   (it now thinks every round); **keep** the guard for Gemini, which still has no
   echo-back.

**Effort:** ~150–250 LOC in that one adapter + types + tests; roughly half a day
to a day. Low blast radius (can't regress other adapters; still behind
`MANTLE_THINKING_BUDGET`).

**Confidence:** high (~90%). The replay contract is documented and is the same
shape we already ship for OpenRouter. Residual risk is the streaming
`signature_delta` capture + the block-first ordering rule (both unit-testable, so
caught before prod), plus one genuine live smoke test (a direct-Anthropic
thinking+tool turn → no 400 on round 2), the same class of live-only check as the
OpenRouter echo-back.

**Gemini** is the analogous follow-up (capture + replay its thought signatures so
it too thinks every round); same pattern, separate block shape.

### 7.2 Provider breadth — what's left from Hermes (audited 2026-06-30)

Compared Hermes' ~26 model-provider plugins against Mantle. Finding: Hermes'
breadth is mostly **one pattern repeated** — a static-key OpenAI-compatible
endpoint differing only in base URL + model list (alibaba/DashScope, arcee, gmi,
kilocode, kimi/Moonshot, novita, nvidia, stepfun, xiaomi, zai/GLM, azure-foundry,
…). Most of those models are *already reachable* through the existing
`openrouter` adapter, and the rest collapse into one generic adapter.

**SHIPPED — `custom` (OpenAI-compatible cloud) provider.** One adapter
([`custom-chat.ts`](../packages/voice/src/adapters/custom-chat.ts)) that takes a
per-route Base URL + API key and reuses the shared `openai-compat` translation +
streamer (so it inherits the `<think>` scrubber and `reasoning_content`
forwarding). Subsumes the entire static-key long tail — point a route at any
vendor's `/chat/completions`, pick/type the model. Distinct from `local` (keyless
self-host/tailnet; cosmetic Bearer): `custom` is the **keyed cloud** path —
Base URL + key both required, no localhost default, no tailnet. Thinking maps
`thinkingBudget`→`reasoning_effort` (Copilot-consistent), sent only under the
gate. Wiring: `providers.ts` (`capabilities:['chat']`, aggregator badge) +
`WIRED_PROVIDERS.chat` + barrel registration; Base URL field surfaced in BOTH the
agents form and the ai-workers form (the shared `RouteHostFields` generalized to
`provider: 'local' | 'custom'`, hiding the tailnet toggle for custom). Runtime
needed **zero** changes — route `baseUrl` already flows for any provider and
`resolveChatKey` treats only `local` as keyless, so `custom` correctly requires a
key. Live model discovery returns empty-with-hint (the keyless `/api/models`
route can't pass the per-route Base URL); the `ModelSelect` free-text
(`allowCustom`) affordance is the model-entry path. 8 wire tests; full voice suite
333 green; web/agent-runtime/assistant-runtime typecheck clean. **Not yet
browser-smoked** (settings forms need a running stack + auth).

**Deliberately NOT built (demand-gated):**
- **`bedrock`** (AWS) — the only other entry with real standalone value, but it
  needs SigV4 signing (not a static key) — real adapter work. Build when a
  customer requires AWS-account billing/compliance.
- **OAuth/subscription providers** (qwen-oauth, nous device-code, openai-codex
  Responses API, minimax OAuth, copilot-acp) — each a bespoke token flow like
  Copilot; niche, per-subscription. Add the specific one a user actually has.
- Single-vendor static endpoints (zai/GLM, kimi, DashScope, nvidia, novita) — no
  bespoke adapter needed: reach them via `openrouter`, or now via `custom` with
  the vendor's base URL + key.

This closes the model audit: the Copilot port covered the one gap that *needed*
bespoke auth code; `custom` covers the breadth; everything remaining is either
already reachable or demand-gated.

#### Future enhancement — thread the route Base URL into model discovery
`discoverModels(apiKey)` has no `baseUrl` param, so a `custom` route can't live-
list `/models` (operators type the model id via `allowCustom`). Making it
discover would be an **additive optional** `discoverModels(apiKey, baseUrl?)` on
the `ChatDispatcher` interface + the `/api/models` route + the form's discovery
trigger passing the typed Base URL. ~Half a day; low priority (free-text already
unblocks configuration).
- **Copilot Responses-API mode** — Hermes switches some models to the OpenAI
  Responses API (`_should_use_copilot_responses_api`); we only implemented chat
  completions. Add if a Copilot model needs it.
- **Known minor:** toggling thinking on→off between rounds busts Anthropic's
  prompt cache on the *direct* paths (not OpenRouter). Accepted — correctness
  over cache.

---

## Key files (Mantle)

```
packages/voice/src/adapters/think-scrubber.ts          # inline <think> scrubber (Hermes port)
packages/voice/src/adapters/reasoning-accum.ts          # OpenRouter reasoning_details accumulator
packages/voice/src/adapters/thinking-guard.ts           # continuation guard for direct Anthropic/Gemini
packages/voice/src/adapters/copilot-auth.ts             # Copilot token exchange + headers (Hermes port)
packages/voice/src/adapters/copilot-chat.ts             # Copilot chat adapter
packages/voice/src/catalogs/copilot.ts                  # Copilot static catalog
packages/voice/src/adapters/anthropic-chat.ts           # adaptive thinking + guard
packages/voice/src/adapters/openrouter-chat.ts          # reasoning request + reasoning_details round-trip
packages/voice/src/adapters/google-chat.ts              # Gemini thinkingConfig + thought parts
packages/agent-runtime/src/tool-loop.ts                 # MANTLE_THINKING_BUDGET gate + reasoning replay
apps/web/components/assistant/use-turn-stream.ts         # accumulate reasoning-delta
apps/web/components/assistant/thought-trail.tsx          # collapsible "Thinking" trace
packages/assistant-runtime/src/stage-label.ts            # retired canned phrases
```
