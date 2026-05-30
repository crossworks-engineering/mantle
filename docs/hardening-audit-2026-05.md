# Hardening audit — May 2026

**An independent audit of the whole system, plus the fixes that came out of it.**
Six commits on `main` (`a394dc3` → `4e20af7`, 2026-05-30), branched from `edd73a8`.
~+945/−105 LOC, +5 test files, suite **1036 passing**, workspace typecheck clean
throughout.

This is the companion to [`phase-3-retrospective.md`](./phase-3-retrospective.md):
that one is the deep-dive on the chat-adapter *design*; this one is the audit
that hardened it (and the memory + data layers) afterwards. Read it to know
**what was found, what was fixed, what was deliberately left, and why** — so
nothing here gets re-pitched or, worse, re-broken.

---

## Part 1 — The method (and one cautionary tale)

The audit ran four read-only subsystem sweeps in parallel — **security &
secrets**, **memory & ingest**, **chat-adapter / agent-runtime**, and **data
layer & workers** — each producing a prioritized findings list with file:line
citations.

**The cautionary tale (read this before trusting any audit output):** the
chat-runtime sweep cited a `packages/agent-runtime/src/adapters/` directory that
**does not exist** — the chat adapters live in `packages/voice/src/adapters/`.
The agent had hallucinated plausible paths and line numbers. The *findings* were
real, but the *citations* were fiction. Two lessons hardened the rest of the
work:

1. **Re-verify every finding against the real code before acting on it.** Every
   fix below was confirmed by reading the actual file, not the audit's
   line number. Several findings shifted in severity on re-verification
   (M3 was *under*-rated; M1/M2 in memory turned out latent, not live).
2. **Don't bundle edits with exploratory shell commands.** A single failing
   `Bash` in a parallel tool batch cancelled the whole batch — including the
   edits riding alongside it — which silently discarded an early attempt at the
   retry work. Edits go in their own batches; verification is separate.

The security sweep, by contrast, used real paths and concluded the codebase is
"unusually security-conscious" — no Critical/High issues, every open item an
accepted single-user trade-off. We took that at face value (a clean verdict is
low-risk to trust) and actioned nothing there.

---

## Part 2 — What was fixed

### Chat-runtime — fully closed

| # | Finding | Fix | Commit |
|---|---------|-----|--------|
| #4 | Native-fetch adapters (anthropic/google/xai/hf/deepseek) had **no retry** — a transient 429/5xx/timeout on any tool-loop iteration aborted the whole turn (OpenRouter alone had SDK retries) | `withChatRetry` + `ChatHttpError` ([retry.ts](../packages/voice/src/adapters/retry.ts)), wrapped once at `getChatAdapter`; OpenRouter left unwrapped (no compounding). Exp. backoff + jitter, honors `Retry-After`. Configurable via `ChatOptions.maxRetries` / `AgentParams.max_retries` | `3a6c7c9` |
| M1 | Direct-Anthropic responder lost the **two-breakpoint system cache** — the gate keyed on the OpenRouter slug `anthropic/`, so bare-id direct-Anthropic agents collapsed persona+digest into one cache block (a digest refresh busted the persona cache) | gate now `provider === 'anthropic' \|\| model.startsWith('anthropic/')`; `provider` threaded into `buildChatMessages` from all 5 call sites | `8773e14` |
| M3 | Google synthetic tool-call ids (`gemini_call_<n>`) **reset per response** → cross-iteration collisions in a multi-step loop could pair a tool result to the **wrong function** | process-monotonic counter | `8773e14` |
| M2 | Anthropic `tool_result` never set **`is_error`** — the model inferred failure from a JSON blob | thread `isError` from the runtime (`outcome.ok`) → set the block flag | `99ffa21` |
| M4 | google-chat **silently dropped images** | translate `data:` URL images → Gemini `inlineData`; warn + skip non-data URLs (google-vision stays the remote path) | `99ffa21` |
| L1 | `agent.params as Record<string, never>` — the "cast that hides drift" anti-pattern | → `as AgentParams` | `99ffa21` |
| L2 | Two scattered `as unknown as` casts in the OR adapter | consolidated to one documented boundary cast | `99ffa21` |
| L3 | `effectiveToolSlugs` had no aggregate cap | cap at 512, log the dropped slugs (not silent) | `99ffa21` |
| L4 | `read_result` auto-offered but could be `requires_confirm` (would strand the model behind /pending) | force `requiresConfirm` off on the auto-offer path | `99ffa21` |

### Memory / ingest — the "silent degradation" cluster

| # | Finding | Fix | Commit |
|---|---------|-----|--------|
| H4 | **Stale facts never retired.** On re-extract, chunks/edges delete-rebuild but facts only ran the classifier against *new* candidates — a fact dropped from an edited document stayed `valid_to=NULL` forever. The `facts.dirty` column the schema documented was unused | implemented the dirty flow: mark this node's live facts suspect → clear each re-asserted (NOOP/UPDATE) → retire leftovers, guarded so a cost-cap break never wrongly retires unprocessed facts | `7d78aa7` |
| M1 | `runReembed` skipped `content_chunks` (backs `search_chunks`, the primary long-doc retrieval) — "Rebuild Index" silently half-migrated | walk `content_chunks` too. `tool_result_chunks` deliberately excluded (transient spill store, self-heals) | `7d78aa7` |
| H2 | Facts retrieval had **no distance threshold** (content hits did) — an embedding-model mismatch surfaced garbage-space rows as real profile facts | loose 0.85 cutoff: a mismatch (dist ≈ 1.0) degrades to "no facts" (visible); legitimate facts still pass | `7d78aa7` |
| H1 | The write-side embedding model and each agent's read-side `memory_config.embedding_model` **must match** or retrieval silently mismatches — nothing enforced it | boot-time `assertEmbeddingModelConsistency()` warns (doesn't throw) naming any divergent agent. No-op today (all overrides null) | `4e20af7` |

### Data layer & deploy

| # | Finding | Fix | Commit |
|---|---------|-----|--------|
| H1 | `nodes.embedding` — the **primary brain table** — had **no vector index**; every semantic retrieval was a full seq-scan (the `0000_init` "added after first batch" follow-up never landed) | partial **HNSW** index, migration `0057` (HNSW needs no training data, sidestepping the deferral). Planner confirmed Seq Scan → Index Scan | `a394dc3` |
| H2 | `docker-compose.yml` shipped only 4 daemons — **files-watch** (external-edit watcher) and **events-reminders** (calendar reminders) had no prod container, and ran only in `pnpm dev` | added `worker-files` + `worker-events` Dockerfile targets + services. MCP left out on purpose (stdio-only → would crash-loop as a daemon) | `a394dc3` |
| H3 (deploy) | No migration-on-boot — compose just told the operator to run migrate by hand | one-shot `migrate` service every app service waits on (`service_completed_successfully`); one dedicated migrator → no race | `7d78aa7` |
| M1 | `drainUnextractedNodes` (boot self-heal) hard-capped to last 24h / 500 rows → a longer outage silently lost work | configurable window/cap (`MANTLE_EXTRACT_DRAIN_WINDOW_HOURS` default 7d, `MANTLE_EXTRACT_DRAIN_LIMIT` default 1000); truncation now logs the true backlog count | `4e20af7` |

---

## Part 3 — What was deliberately NOT done, and why

### Deferred: memory-H3 (eager-summary UPDATE backstop) — *cost-safety*

The gap: a *future* writer (or a raw DB edit) that updates a node body without
nulling `embedding` leaves a permanently stale summary. The obvious fix is an
`AFTER/BEFORE UPDATE` trigger on `nodes` that re-extracts on content change.

**We are not building that.** A trigger must diff the body portion of the `data`
jsonb, but the body key differs per node type AND the extractor writes
`summary` + typed fields back into `data` — get the condition slightly wrong and
you get a **re-extraction loop or mass re-extraction = unbounded LLM spend** on
the hottest table. Affordable LLM calls are a prime feature of Mantle; a runaway
extraction storm is the one failure worse than a little staleness. And there is
**no live path hitting the gap today** — every existing editor already nulls
`embedding` on content change. The floor on the downside is "one node's summary
goes stale" (cheap, visible) vs. an unbounded bill.

If ever revisited, the only acceptable shape is loop-safe + cost-bounded: stamp
`data.embedded_at` in the extractor and a reconciler gated on a *real*
body-changed check (not bare `updated_at`, which over-fires on benign tag/path
edits). Test against the dev DB first. This rule is recorded in agent memory
(`project_cost_safety_no_reextract_trigger`).

> **The general rule it generalizes to:** before adding any trigger, cron,
> heartbeat, or watcher that can invoke a model, ask *"what's the worst-case call
> volume if this misfires?"* If it's unbounded, redesign or don't ship it.

### Accepted: chat-runtime cost findings (H1/H2)

The fallback price table double-subtracts cache tokens for direct
Anthropic/Google, and cache-*write* tokens are unpriced. Accepted as-is:
OpenRouter (the primary route) reports real cost via `reportedCostUsd`;
direct-provider cost is approximate by design and the operator knows it.

---

## Part 4 — Still open (lower priority, not actively degrading)

Honest residue. These are real but latent / low-frequency, and several are
Medium/Low findings from the original audit that weren't deep-re-verified
(treat their specifics as leads, not gospel — see the cautionary tale):

- **Memory** — re-embed `textForNode` uses different text than the extractor
  (`[title, summary, body[:500]]` vs `[title, summary]`), so vectors drift even
  on the *same* model after a rebuild; **digest retrieval is recency-based**
  while the docs claim embedding-ranked (doc-vs-code mismatch); relation edges
  aren't deduped across source nodes; reflector watermark race can skip a
  signal; entity alias collisions aren't constrained.
- **Data layer** — `LISTEN` has no *drain* on reconnect (postgres-js
  auto-resubscribes, so it's not "dead forever" as first reported — just
  notifies missed *during* the disconnect window); no drain for missed
  summarize/index ticks.
- **Security** — all accepted single-user trade-offs: in-memory rate limiter,
  1-year stateless session cookie (no per-session revoke), plaintext share
  tokens, no SSRF allowlist on operator-configured URLs.

None of these is silently corrupting data or burning money today.

---

## Part 5 — Themes worth carrying forward

1. **Silent degradation is the enemy of a source-of-truth.** The highest-value
   fixes all share a shape: the system *kept appearing to work while quietly
   returning wrong/stale data* — unindexed seq-scans, stale facts, garbage-space
   retrieval on a model mismatch, a half-migrated rebuild, a dropped notify.
   The fixes turn "wrong but populated" into "empty/visible/logged."
2. **No silent caps.** Every bound we added (drain cap, tool-slug cap, fact
   cost-cap) *logs what it dropped*. A cap that hides truncation reads as
   "covered everything" when it didn't.
3. **Cost-bounded by construction.** See Part 3. The drain cap is mandatory for
   the same reason the re-extract trigger is banned.
4. **Verify before you fix.** Subagent file:line citations are leads, not facts.

---

## Commit timeline

| sha | what |
|-----|------|
| `a394dc3` | HNSW index on `nodes.embedding`; files/events workers shipped to prod |
| `3a6c7c9` | chat retry/backoff (`withChatRetry` + `ChatHttpError`) |
| `8773e14` | direct-Anthropic cache breakpoints (M1) + unique Google tool-call ids (M3) |
| `99ffa21` | `is_error` (M2), Gemini image translation (M4), L1–L4 cleanups |
| `7d78aa7` | stale-fact retirement (H4), chunk re-embed (M1), facts mismatch guard (H2), migrate-on-boot |
| `4e20af7` | embedding-model consistency check (H1) + configurable, visible extract drain (M1) |

## Reading order for a future contributor

1. This doc — what was hardened and what's deliberately left.
2. [`phase-3-retrospective.md`](./phase-3-retrospective.md) — the chat-adapter design these fixes build on.
3. [`packages/voice/src/adapters/retry.ts`](../packages/voice/src/adapters/retry.ts) + `retry.test.ts` — the retry layer.
4. [`apps/agent/src/extractor.ts`](../apps/agent/src/extractor.ts) `classifyAndApplyFact` + the fact pass — the dirty-flow reconciliation.
5. `architecture.md` §16 — the live known-sharp-edges list (this audit's closed items removed from it).
