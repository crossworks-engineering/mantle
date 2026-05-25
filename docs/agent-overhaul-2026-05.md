# Agent & tool-result overhaul (May 2026)

A cohesive overview of a body of work that hardened how Mantle's agents
delegate, how the system knows what a model can do, and — the centrepiece —
how oversized tool output is handled so an agent can actually *finish a job*.
The detailed reference for each piece lives in
[`architecture.md`](./architecture.md) and [`ai-workers.md`](./ai-workers.md);
this doc is the through-line that ties them together and the place to start.

---

## 1. The principles (why these changes hang together)

Four ideas recur across everything below. They're the reason the pieces feel
like one overhaul rather than a list of fixes.

1. **Store full, index compact, dereference on demand.** The brain already does
   this for ingested content (`content_store` ↔ `content_index`) and recall does
   it for conversation (message archive ↔ `conversation_digest`). The new
   **tool-result spill store** is the third instance of the same pattern, for
   ephemeral tool output. Never force-fit a large thing into the hot path; keep
   a handle and fetch what you need.

2. **Bounded / correct by construction, not by recurring cleanup.** Prefer a
   structural guarantee (a ceiling, a delete-then-rebuild, a single writer) over
   a cron that mops up afterwards. Where cleanup *is* needed (TTL), it's
   deterministic and self-throttling — not aspirational.

3. **One authoritative live source over hand-maintained tables.** Model context
   windows and capabilities now come from OpenRouter's live catalog (cached,
   fallback) instead of a static map that silently goes stale.

4. **Surface loudly, don't auto-fix silently.** A health signal that *alerts*
   beats a blind auto-cleaner that masks the regression it's hiding (see the
   duplicate-edge guard, and why a `dedupe:edges` heartbeat was deliberately
   *not* added).

---

## 2. What changed

### 2a. Voice — wrapping speech tags for Grok (`<whisper>`)
The TTS framework modelled only inline `[bracket]` cues. Grok voice also honours
**wrapping** tags that style a whole span — `<whisper>…</whisper>`, `<soft>`,
`<loud>`, `<slow>`, `<high>`, `<singing>`. Added a generic `WrappingTag`
vocabulary alongside `AudioTag`, advertised per-model
(`supportedWrappingTags`), injected into Saskia's prompt, and **stripped from
text-mode replies** (keeping the inner words) so the markers never leak.
→ [`ai-workers.md` §5a](./ai-workers.md#5a-speech-tags--inline--wrapping)

### 2b. Agent delegation, made to actually work
`invoke_agent` was sound, but two things made it look broken:
- **`delegate_to` had no UI and was being wiped.** The allowlist lived only in
  `memory_config.delegate_to` (seed-only), and the agents form *overwrote*
  `memory_config` wholesale on save — silently dropping the grant. Now there's a
  **"Delegates to" picker**, and `updateAgent` **jsonb-merges** `memory_config`
  so a save never drops unmanaged keys.
- **Researcher shipped** as the outward delegation twin of Remy (web search via
  Perplexity Sonar → cited synthesis).
→ [`architecture.md` §9b'](./architecture.md#9b-agent-delegation-invoke_agent)

### 2c. Live model catalog — context window + capabilities
A hand-maintained table claimed Claude Sonnet/Opus were 200 K when OpenRouter
actually serves **1 M**, so the dashboard over-reported context fill 5×. Now
`refreshModelCatalog()` fetches OpenRouter's public `/api/v1/models` (keyless,
6 h TTL, 8 s timeout, never-throws) and drives **both** the context window
(`contextLimitFor`) **and** vision support (`modelSupportsVision`, from
`architecture.input_modalities`), with an accurate static fallback. Surfaced in
the usage card and the agents-form model readout. (Context is a property of the
model *slug*, not a request flag.)
→ [`architecture.md` §9l](./architecture.md#9l-model-catalog--live-context-window--capabilities)

### 2d. Tool-result spill store (`read_result`) — the centrepiece
The single most common reason integrated assistants quit mid-task: a big tool
result (a delegated agent's full synthesis, a wide `file_read`/search) was
hard-truncated to ~8 KB, silently dropping the answer. Now oversized output
**spills to an ephemeral store** and the model gets a handle + preview it
dereferences via `read_result`:
- **`page`** — byte-accurate, newline-snapped linear reading.
- **`grep`** — exact substring with context.
- **`query`** — semantic search *within* the result (lazily chunks + embeds on
  first use; cosine scoped to the one result).

Bounded on every axis: inline cap (32 KB), a hard storage ceiling
(head-truncate beyond `spill_max`), an adaptive **chunk cap**
(`TOOL_RESULT_MAX_CHUNKS`), and a real **TTL sweep** (`maybeSweep()` on the
events-reminders tick + opportunistically on spill). An **in-band preview cut
marker** guards against answering from a truncated head.
→ [`architecture.md` §9m](./architecture.md#9m-tool-result-spill-store-read_result)

### 2e. Duplicate-edge guard (dashboard)
`mentioned_in` edges are written by one writer (the extractor) that
delete-then-rebuilds, so duplicates can't accumulate. Rather than a recurring
`dedupe:edges` job (which would mask a regression), the dashboard's
**Memory-index** card shows a live duplicate-edge count: green when clean, amber
with the one-shot remedy (`pnpm dedupe:edges --apply`) if a regression ever
appears. A monitor, not a fixer.
→ [`architecture.md` §9k](./architecture.md#9k-re-extract-is-idempotent-no-duplicate-brain-rows)

---

## 3. Configuration surfaces

Everything operator-tunable landed in the UI where it's per-agent, and in env
where it's global store policy.

**Agents form (`/settings/agents`):**
- **Delegates to** — the `invoke_agent` allowlist (per agent).
- **Tool results** — `inline_max_kb`, `embed_min_kb`, `spill_max_kb` (per agent).

**Environment (global store policy):**
- `TOOL_RESULT_INLINE_MAX` / `_EMBED_MIN` / `_SPILL_MAX` / `_PAGE_BYTES` —
  defaults for the per-agent knobs + the global page size.
- `TOOL_RESULT_MAX_CHUNKS` — embed-tier fan-out cap.
- `TOOL_RESULT_TTL_DAYS` — spill retention.

Why the split: per-agent knobs are *behaviour*; max-chunks and TTL are *store
policy* (and the `read_result` query path carries no per-agent context). A
safety ceiling per-agent would be a foot-gun.

---

## 4. Audits & what remains

Both delegation and the spill store were audited; findings and their status live
in [`architecture.md` §16](./architecture.md#16-known-sharp-edges--future-work).

**Resolved this overhaul:** the 8 KB truncation (→ spill store); unbounded
store growth (→ size ceiling + chunk cap + scheduled TTL); answering from a
cut-off preview (→ in-band marker); mid-word/JSON paging + byte/char mixing
(→ byte-accurate, newline-snapped paging); per-turn `resolveTool` (→ memoised);
the stale context table (→ live catalog); the `delegate_to` wipe (→ merge + UI).

**Still open (tracked, non-blocking):**
- **Lazy-embed TOCTOU race** — concurrent first-`query` on one handle can
  double-insert chunks. Fix: unique `(result_id, ordinal)` + `ON CONFLICT DO
  NOTHING` (a small migration).
- **No automated coverage of the DB-backed `read_result` paths** — gated on the
  repo's general "test Postgres" story; pure helpers + live verification cover
  the rest today.

---

## 5. Files (where the code lives)

| Concern | Files |
|---|---|
| Wrapping speech tags | `packages/voice/src/{adapters/types,catalogs/xai,audio-tags}.ts` |
| Delegation guards + bridge | `packages/tools/src/{invoke-agent-guards,agent-bridge}.ts`, `packages/agent-runtime/src/invoke-agent.ts` |
| `delegate_to` UI + merge | `apps/web/app/(app)/settings/agents/agents-client.tsx`, `apps/web/lib/agents.ts` |
| Model catalog | `packages/tracing/src/model-context.ts` |
| Tool-result store | `packages/tools/src/{tool-results,builtins-tool-results}.ts`, `packages/agent-runtime/src/tool-loop.ts`, `packages/db/src/schema/tool-results.ts` |
| TTL sweep hook | `apps/web/workers/events-reminders.ts` |
| Duplicate-edge guard | `apps/web/lib/dashboard.ts`, `apps/web/components/dashboard/brain-stats.tsx` |
