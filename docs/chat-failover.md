# Chat route failover — primary + backup

**Shipped 2026-05-31** (runtime, migration `0062`); **operator UI + per-route host + key consolidation 2026-06-01** (migration `0063`). "Run a local model with a cloud safety net" for agents and chat-shaped workers — now fully wired end to end (config UI included; see §10–§12). This is the canonical implementation reference; the operator-facing summary lives in [`ai-workers.md` §7a](./ai-workers.md#7a-chat-route-failover-primary--backup), and the local-model / tailnet companion in [`tailscale.md`](./tailscale.md).

It is the **chat sibling** of the embedding failover ([`embeddings.md`](./embeddings.md)) — same shape, one critical difference (covered in [§7](#7-why-chat-differs-from-embeddings)).

---

## 1. The problem

Capable chat models (gemma-3-12b, Llama, Mistral-large) don't fit Mantle's base 8GB/6-core VPS — they need a beefier box, often a GPU. So the natural deployment is: run them on a machine you own and point Mantle's chat routes at it. But a self-hosted box can be **down** (LM Studio not running, the machine asleep, a hung request, a 5xx under load). If the summarizer's only route is that box, ingestion stalls.

Failover fixes the availability gap: configure a **backup** chat route, and when the primary is unreachable the runtime answers on the backup instead. The backup is typically a cloud model — always-on, pay-per-call — so "local-primary, cloud-fallback" gives you the cost/privacy win of local with the reliability of cloud.

---

## 2. The shape, in one diagram

```
  agents / ai_workers row
  ┌────────────────────────────────────────────────────────────┐
  │ provider / model / api_key_id          ← the ACTIVE route   │
  │ backup_provider / backup_model /                            │
  │ backup_api_key_id / backup_enabled     ← the BACKUP route   │
  └───────────────────────────┬────────────────────────────────┘
                              │  resolveChatRoutes(row)
                              ▼
                  { primary: ChatRoute, backup: ChatRoute | null }
                              │
        ┌─────────────────────┴──────────────────────┐
        ▼                                            ▼
  single-shot workers                          tool-loop agents
  (extractor / summarizer / reflector)         (responder / assistant /
        │                                       heartbeat / invoke_agent)
        ▼                                            ▼
  chatWithFailover(owner, routes, opts)        runToolLoop({ adapter, backup, … })
        │                                            │
        │  try primary → on isChatFailover →         │  active-route pointer;
        │  call backup                               │  flip to backup on failure,
        ▼                                            ▼  STICKY for the rest of the turn
   { result, usedProvider, failedOver }        reply (served by whichever route)
```

The **active columns are always the primary**. The "make backup primary" swap (Phase 4 UI) just exchanges the two sets of column values, so the runtime never needs precedence logic — it always tries `provider/model/api_key_id` first.

---

## 3. The data model (migration `0062`)

Four additive, defaulted columns on **both** `agents` and `ai_workers`:

```sql
ALTER TABLE "agents"     ADD COLUMN "backup_provider"   text;
ALTER TABLE "agents"     ADD COLUMN "backup_model"      text;
ALTER TABLE "agents"     ADD COLUMN "backup_api_key_id" uuid REFERENCES api_keys(id) ON DELETE set null;
ALTER TABLE "agents"     ADD COLUMN "backup_enabled"    boolean DEFAULT false NOT NULL;
-- …identical block for ai_workers…
```

- **Additive + defaulted** ⇒ every existing row is unchanged. `backup_enabled = false` means "no backup," which is the pre-migration behaviour exactly. Zero-risk deploy.
- **`api_key_id` FK is `SET NULL`** (not cascade), matching the primary `api_key_id` — deleting a key doesn't delete the agent, it just unpins.
- Mirroring the column names across the two tables is deliberate: one `ChatRouteRow` shape (below) serves both.

Schema source: [`packages/db/src/schema/agents.ts`](../packages/db/src/schema/agents.ts), [`packages/db/src/schema/ai-workers.ts`](../packages/db/src/schema/ai-workers.ts).

---

## 4. The primitives ([`chat-failover.ts`](../packages/agent-runtime/src/chat-failover.ts))

Everything lives in `packages/agent-runtime/src/chat-failover.ts` and is re-exported from the package barrel. Five exports:

### `resolveChatRoutes(row): ChatRoutes`

Pure. Splits a row into `{ primary, backup }`. The backup is only live when **enabled AND fully configured**:

```ts
backup: row.backupEnabled && row.backupProvider && row.backupModel
  ? { provider: row.backupProvider, model: row.backupModel, apiKeyId: row.backupApiKeyId ?? null }
  : null
```

A `ChatRoute` is the minimal `{ provider, model, apiKeyId }`. `ChatRouteRow` is the column shape shared by agents + workers, so both tables flow through the same function.

### `isChatFailover(err): boolean`

The failover predicate — **and the most important reuse decision in the whole feature**:

```ts
export function isChatFailover(err: unknown): boolean {
  return classifyChatError(err).retry;
}
```

`classifyChatError` already exists in [`packages/voice/src/adapters/retry.ts`](../packages/voice/src/adapters/retry.ts) — it's what the per-adapter retry wrapper (`withChatRetry`) uses to decide whether to retry a call. Its `RETRYABLE_STATUS` set is `{408, 409, 425, 429, 500, 502, 503, 504}`, plus it treats `TypeError` (undici network failures), `AbortError`/`TimeoutError`, `ECONNREFUSED`/`ETIMEDOUT`/`fetch failed`/`socket hang up`, and an **empty/truncated JSON body** (`isEmptyJsonBodyError` — a `SyntaxError: "Unexpected end of JSON input"` from `JSON.parse('')`, the signature of an upstream stall that returned an unparseable 2xx) as retryable.

> **The empty-body case (added after a prod incident).** A web assistant turn died with a context-free "Unexpected end of JSON input" after a 34s stall on its 3rd model call: the upstream returned an empty 2xx body and `@openrouter/sdk`'s `JSON.parse` threw a bare `SyntaxError`. The SDK retries HTTP transients but not a thrown parse error, and the OpenRouter adapter is intentionally **not** wrapped by `withChatRetry` (its SDK owns HTTP-level retries — double-wrapping would compound attempts). So `openrouter-chat.ts` retries *only* this empty-body case itself (full-jitter backoff, honoring `opts.maxRetries`) and, on exhaustion, throws `OpenRouterEmptyResponseError` naming the model + elapsed time instead of the bare parse message. `classifyChatError` learns the same signature so the failover predicate and the `withChatRetry`-wrapped direct adapters treat it transient too. Matched **only** for the end-of-input family — a complete-but-malformed body is a real bug we must surface, not retry.

So "should we fail over?" is **exactly** "is this a transient error the retry layer would itself retry?" — 429 rate-limit, 5xx, network-down, timeout, empty-body stall → yes; 4xx bad-input / 401 auth / context-length → no (a second route fails identically). Reusing the canonical classifier means the failover decision and the retry decision can never drift apart, and it's tested in one place. This required exposing `classifyChatError` / `ChatHttpError` from the `@mantle/voice` adapters barrel (they were module-private before).

### `resolveRouteAdapter(ownerId, route): ResolvedChatRoute`

Turns a `ChatRoute` into a callable `{ adapter, apiKey, model, provider }`:
- `getChatAdapter(route.provider)` — throws if the provider isn't wired.
- API key: route-pinned `apiKeyId` wins → fall back to `getApiKey(owner, provider)` → **`local` is keyless** (a self-hosted OpenAI-compatible chat server needs no credential, mirroring the embedding adapter's keyless-local handling).

### `chatWithFailover(ownerId, routes, opts): { result, usedProvider, failedOver }`

The single-shot wrapper. `opts` is `RoutelessChatOptions` (= `ChatOptions` minus `apiKey` and `model` — each route supplies its own, which is how the backup can run a *different* model):

```ts
const primary = await resolveRouteAdapter(ownerId, routes.primary);
try {
  const result = await primary.adapter.chat({ ...opts, apiKey: primary.apiKey, model: primary.model });
  return { result, usedProvider: primary.provider, failedOver: false };
} catch (err) {
  if (!routes.backup || !isChatFailover(err)) throw err;     // no backup, or a 4xx → rethrow
  const backup = await resolveRouteAdapter(ownerId, routes.backup);
  const result = await backup.adapter.chat({ ...opts, apiKey: backup.apiKey, model: backup.model });
  return { result, usedProvider: backup.provider, failedOver: true };
}
```

The primary's own internal retries (in `withChatRetry`) run *first*; `chatWithFailover` only sees the error after those are exhausted, so failover is a genuine "primary is down" signal, not a flaky single-request blip.

### `resolveBackupAdapter(ownerId, row): ResolvedChatRoute | undefined`

For the tool-loop callers (below). Resolves the row's backup to a callable adapter, **or `undefined` when there's no backup OR it can't be resolved**. This is the safety valve: a misconfigured backup (unwired provider, deleted key) must **never** break the primary path — failover just becomes unavailable, and we log why. The catch swallows the error and returns `undefined`.

---

## 5. Integration A — single-shot workers

The chat-shaped workers each do one `adapter.chat()` call inside a trace `step`. The migration was mechanical: replace the manual `getChatAdapter(worker.provider)` + `getApiKeyById(worker.apiKeyId)` + `adapter.chat({...})` with `chatWithFailover(ownerId, resolveChatRoutes(worker), {...})`.

| Worker | File | Note |
|---|---|---|
| Extractor | [`extractor.ts`](../apps/agent/src/extractor.ts) | `chatComplete(adapter, apiKey, model, …)` → `chatComplete(ownerId, routes, …)`. `classifyAndApplyFact` dropped its `adapter`/`apiKey` params and resolves routes from the worker it already holds. |
| Summarizer ×2 | [`summarizer.ts`](../apps/agent/src/summarizer.ts) | Telegram + web paths, identical swap. |
| Reflector | [`reflector.ts`](../apps/agent/src/reflector.ts) | Same. |

Each logs when it answers via the backup (`[summarizer] summarized via backup route (…)`), and `recordChatUsage` is given `result.model || routes.primary.model` so the trace + cost dashboard attribute usage to the model that actually served.

**Switch-back here is trivial:** there's no loop, so every invocation calls `chatWithFailover` fresh and tries the primary first. Summarize #1 fails over to cloud; summarize #2 a minute later tries local gemma again. Stateless self-heal, no bookkeeping.

The pre-existing config guards (skipped-trace on a missing key/adapter) stay — they're *primary-route* checks done before the call, separate from *runtime* failover.

---

## 6. Integration B — the tool loop (sticky)

Agents run a multi-iteration tool loop ([`tool-loop.ts`](../packages/agent-runtime/src/tool-loop.ts)), so failover is subtler: a failure can happen on iteration 3 of a reasoning chain.

`ToolLoopArgs` gains an optional `backup?: { adapter, apiKey, model }` (a pre-resolved route — keeps the test harness's ability to inject a fake adapter as the primary). The loop holds an **active-route pointer**:

```ts
let active = { adapter: args.adapter, apiKey: args.apiKey, model: args.model };
let failedOver = false;

for (let iter = 0; iter < maxIters; iter++) {
  const result = await step({ name: `${active.adapter.adapterName}_chat[…]`, … }, async (h) => {
    const chatOpts = { messages, …cacheControl, …params };
    try {
      const r = await active.adapter.chat({ apiKey: active.apiKey, model: active.model, ...chatOpts });
      recordChatUsage(h, r, active.model);
      return r;
    } catch (err) {
      if (!args.backup || failedOver || !isChatFailover(err)) throw err;
      active = { adapter: args.backup.adapter, apiKey: args.backup.apiKey, model: args.backup.model };
      failedOver = true;                 // ← sticky: only once per turn
      const r = await active.adapter.chat({ apiKey: active.apiKey, model: active.model, ...chatOpts });
      recordChatUsage(h, r, active.model);
      return r;
    }
  });
  …
}
```

**Why sticky?** Once iteration 3 fails over to the backup, the loop stays on the backup for iterations 3, 4, 5… of the same turn. Flip-flopping models mid-reasoning (one paragraph from gemma, the next from Claude, the next from gemma) is worse than finishing the user's request coherently on one model. The `failedOver` flag makes failover a once-per-turn event. The **next** turn calls `runToolLoop` again and starts on the primary — that's the switch-back.

The trace step name/input and `recordChatUsage` follow `active`, so `/traces` shows which model actually ran each iteration, and iterations after a failover carry `failed_over: true`.

**Callers.** All four resolve the backup defensively and pass it:

```ts
runToolLoop({ adapter, apiKey, model, backup: await resolveBackupAdapter(ownerId, agent), … })
```

- Responder — [`apps/agent/src/main.ts`](../apps/agent/src/main.ts)
- Web assistant — [`apps/web/lib/assistant.ts`](../apps/web/lib/assistant.ts)
- Heartbeat — [`packages/heartbeats/src/fire.ts`](../packages/heartbeats/src/fire.ts) (the backup is resolved in the enclosing async scope, since the `runToolLoop` call sits inside a non-async `withHeartbeatContext` callback)
- `invoke_agent` — [`packages/agent-runtime/src/invoke-agent.ts`](../packages/agent-runtime/src/invoke-agent.ts)

---

## 7. Why chat differs from embeddings

The embedding failover ([`embeddings.md` §Primary + backup routes](./embeddings.md#primary--backup-routes-failover)) looks identical but carries a hard constraint the chat version doesn't: **the embedding backup MUST be the same model.**

Embeddings are **vector-space-locked**. Two different embedding models produce vectors in different coordinate systems, so if the backup embedded a query with another model it wouldn't cosine-match the corpus the primary built — retrieval silently returns garbage, and anything ingested during the outage is permanently off-space until re-embedded. The embedding backup is therefore the *same* model on a different host.

Chat has **no such lock**. Answering one turn (or one tool-loop iteration) on gemma and the next on Claude has no correctness cost — they're both just producing text. So the chat backup is free to be a **completely different provider and model**, which is precisely what makes "local primary, cloud fallback" useful: your fallback can be the best cloud model even though your primary is a 12B local one.

This is why the two features share a shape but not a constraint, and why the chat one was the *simpler* build despite touching more call sites.

---

## 8. Decisions (locked)

1. **Failover triggers: route-down + 429 + 5xx; never 4xx.** 429 (rate-limit) is explicitly in scope — for a local-primary that's overloaded, or a cloud-primary that's throttling, the backup should pick up. 4xx (bad input, context-length, auth) rethrows because the backup would fail identically.

2. **Optimistic, stateless switch-back — no circuit breaker.** Sticky within a turn; every fresh call/turn tries the primary first. The accepted cost: a primary that *hangs* (vs refuses fast) pays one timeout per turn while it's down. A box that's simply off refuses in milliseconds, so the common case is ~free. A circuit breaker (skip a known-down primary for a cooldown, half-open probe to recover) is the documented next step **only if the hang case proves real** — deliberately deferred to keep v1 simple and stateless.

   Implication worth knowing: keep the primary chat timeout reasonably short (and configurable) so the per-turn tax during a hang is bounded and failover is snappy.

---

## 9. Testing

- [`chat-failover.test.ts`](../packages/agent-runtime/src/chat-failover.test.ts) (7) — `chatWithFailover` (primary success / 5xx→backup / 4xx→rethrow / no-backup→rethrow, asserting the backup's *different* model served), `resolveChatRoutes` mapping (enabled / disabled / incomplete), `isChatFailover` classification (429/5xx/network yes; 400/401 no). Partial-mocks `@mantle/voice` (override `getChatAdapter`, keep the real `classifyChatError`) so the transient/permanent decision is exercised for real.
- [`tool-loop.test.ts`](../packages/agent-runtime/src/tool-loop.test.ts) (+3) — route-down→backup, 4xx→rethrow-backup-untouched, and the **sticky** case: a primary that always throws + a backup scripted for a tool-call iteration then a final answer; asserts the primary was attempted **exactly once** while the backup served **both** iterations.
- [`extractor-chat.test.ts`](../apps/agent/src/extractor-chat.test.ts) — migrated to the new `chatComplete(ownerId, routes, …)` signature.

49 `agent-runtime` tests green; monorepo typecheck clean throughout.

---

## 10. Operator UI — Phase 4 (SHIPPED)

The backup route + per-route host are fully configurable from the UI — no SQL needed.

- **API zod**: the backup fields (`backupProvider/backupModel/backupApiKeyId/backupEnabled`) and the per-route host fields (`baseUrl/viaTailnet/backupBaseUrl/backupViaTailnet`, migration 0063) are on the agents create/update zod ([`route.ts`](../apps/web/app/api/agents/route.ts) + `[id]/route.ts`) and the ai-workers action parse (`parseBackupFromForm`).
- **agents-client.tsx + worker-form.tsx**: a "Backup route" section (provider/model/key + enable switch), a **"Make backup primary"** swap (exchanges the primary↔backup form values *including* host + tailnet flag, so a route moves whole), and a `RouteHostFields` control (base-URL input + "Reach via Tailscale" switch) shown only when a route's provider is `local`. The worker form gates the backup section to chat-shaped kinds; the agents form shows it for all conversational agents.

Shipped `5220834` (chat backup UI) + `ba0aa91` (per-route host UI). Pure config ergonomics — no new runtime behaviour.

## 11. Sharp edges / future

- **No circuit breaker** (see §8.2) — a hanging primary costs one timeout per turn until it recovers. Still the documented next step *if* the hang case proves real.
- **The `local` chat adapter shipped** (`4cbbeeb`) — `getChatAdapter('local')` resolves an OpenAI-compatible dispatcher (`packages/voice/src/adapters/local-chat.ts`) that honours a per-route `baseUrl` + `viaTailnet`, reusing the `openai-compat` helpers like `local-embedding`. Running a local chat model as the primary is live (see [`tailscale.md`](./tailscale.md) + [`ai-workers.md` §7a](./ai-workers.md#7a-chat-route-failover-primary--backup)).
- **Per-route base URL for chat is threaded** (migration 0063, `7e81ae4`): `ChatRoute` carries `baseUrl` + `viaTailnet`, mapped by `resolveChatRoutes` for primary AND backup, so the two can point at different hosts. The matching operator UI is the `RouteHostFields` control above.

## 12. Key resolution — one source of truth (`resolveChatKey`)

`resolveChatKey(ownerId, route)` (in [`chat-failover.ts`](../packages/agent-runtime/src/chat-failover.ts), `e351324`) is the **single** decision for "does this chat route have a usable key?" — shared by the dispatch (`resolveRouteAdapter` calls it) AND every worker / agent pre-flight, so the two can never drift. Resolution order: route-pinned key → the provider's canonical **service key** → the `local` keyless sentinel. Non-throwing — returns `{ ok, apiKey } | { ok: false, disposition, detail }`; the dispatch throws on a miss, a worker skips with a trace.

This replaced **7 copy-pasted `!apiKeyId` guards** (extractor / summarizer ×2 / reflector ×2 / responder / invoke_agent) that had silently drifted: when `local` workers were first configured (keyless), the stale guards skipped them entirely. Two behaviours worth knowing: (1) keyless `local` always resolves; (2) the **service-key fallback** means a worker with no *pinned* key but a saved service key for its provider now runs — the pre-flight finally agrees with the dispatch (the old per-worker guards checked only the pinned `apiKeyId` and could wrongly skip). No key anywhere → still skips. Adding the next keyless provider is a one-line change here.

## Commit map

**Runtime (Phases 1–5):** `9c69595` schema + primitives · `a5ff1ef` single-shot worker failover · `56be768` tool-loop sticky failover · `69104af` tests + docs.
**Phase 4 + tailnet:** `5220834` chat backup UI · `7e81ae4` per-route base_url/via_tailnet (migration 0063) threaded end-to-end · `ba0aa91` per-route host UI.
**Hardening:** `58919f4` don't skip keyless-`local` workers · `e351324` consolidate 7 key guards into `resolveChatKey`.
All on `main`. Related: [`tailscale.md`](./tailscale.md) (local chat adapter + tailnet).
