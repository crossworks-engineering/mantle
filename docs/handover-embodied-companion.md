# Handover — embodied companion: networked MCP + personality over the wire

> **For a fresh session.** Make Mantle the brain + personality of an embodied
> agent — the concrete motivating case: a robot with a local H200 running its
> own models, that needs a persistent character and a queryable memory over
> the network. Two workstreams: **(A)** a networked MCP transport, and
> **(B)** "personality over the wire" — letting an external body run a full
> responder turn (persona + memory + tools) instead of just raw memory
> tools. B is the headline; A is the enabler for the robot's own tool use.

## 0. One fact-check before anything

`docs/architecture.md` §10 claims the HTTP+SSE transport "is supported by
the code path but not wired" — **that is stale; the code does not exist.**
[`apps/mcp/src/server.ts`](../apps/mcp/src/server.ts) imports only
`StdioServerTransport` (line ~22, connected at ~1340); there is no
`MCP_HTTP_PORT` anywhere. Workstream A is a *build* (small — the MCP SDK
ships `StreamableHTTPServerTransport`), not a flag flip. Fix §10 when A
lands.

## 1. Why this fits Mantle (the pitch, for orientation)

A robot's defining deficits are continuity and character — exactly Mantle's
products: the persona stack (seed prompt + reflector-learned notes + Life
Logs identity), facts that supersede instead of duplicate, digests + lossless
recall, heartbeats for proactive behavior. The adapter framework already
routes chat to local models (`local`/openai-compat, tailnet dispatch,
failover), embeddings are local by default, and the unified conversation
stream was designed so a new body is just a new channel. The H200 turns the
cost story into a **latency** story: Mantle's surgical per-question context
assembly = short prompts = fast local inference.

## 2. Workstream A — networked MCP

**Today:** `apps/mcp` is stdio-only, runs as a child of Claude Desktop/Code,
auth = "you can exec it" (single-owner trust model, argued at the top of
`server.ts`). It is deliberately **not** in docker-compose (a detached stdio
daemon would EOF-crash-loop — Dockerfile header + architecture §16).

**Build:**

1. Add a transport switch to `apps/mcp/src/server.ts`: default stdio
   (unchanged for Claude Desktop), `MCP_HTTP_PORT` set → serve the SDK's
   **Streamable HTTP** transport (`@modelcontextprotocol/sdk` ships it;
   prefer it over legacy SSE).
2. **Auth is mandatory before this listens on anything but localhost.** The
   donor pattern is federation's sealed per-peer bearer tokens
   ([`docs/federation.md`](./federation.md), `@mantle/crypto` seal/open) —
   mint a token at `/settings/` (or reuse the api-keys vault with
   `service='mcp-client'`), require `Authorization: Bearer` on every
   request, constant-time compare. Owner-scoping stays as-is (the server
   already resolves the single owner).
3. Compose: a new `mcp` service gated behind a profile (like `tailnet`
   was), `MCP_HTTP_PORT` exposed **only** on the internal network /
   localhost / tailnet — never through Caddy unauthenticated. For the robot
   case, tailscale is the natural wire (the sidecar already exists).
4. Keep stdio the default everywhere; HTTP is opt-in.

## 3. Workstream B — personality over the wire

**The gap:** MCP's ~30 tools expose the *memory*; the *character* — the
persona block, identity context, fact/digest/chunk retrieval, the tool loop
— is assembled per-turn by the agent runtime, reached only via channels
(web `/assistant`, Telegram). A robot on raw MCP tools gets the brain
without the soul.

**Two designs, not exclusive — recommended order: B1 then B2.**

### B1. The robot is a channel (the designed path)

[`docs/conversation.md`](./conversation.md) §9's promise: a new channel only
needs to `recordTurn(channel='<new>')` into the unified per-(owner, agent)
stream. Concretely:

1. `assistant_messages.channel` is a **`text` column** typed as the
   `ConversationChannel` TS union
   ([`packages/db/src/schema/assistant-messages.ts:62`](../packages/db/src/schema/assistant-messages.ts))
   — **no migration**; extend the union with `'robot'` and chase the type
   errors.
2. New authenticated endpoint, e.g. `POST /api/channels/robot/turn`
   `{agent_slug?, text}` → calls the same orchestration as
   `runAssistantTurn` ([`apps/web/lib/assistant.ts:154`](../apps/web/lib/assistant.ts))
   with `channel: 'robot'` → returns the reply text (+ optional artifacts).
   Note `runAssistantTurn` currently hardcodes `channel: 'web'` in its
   `recordTurn` calls — parameterize it. Auth: same sealed-bearer pattern
   as Workstream A (this endpoint runs a full paid LLM turn; treat the
   token like a key).
3. **Known pothole (from the June audit, still open):** `recall_window`
   hardcodes `eq(channel, 'web')` for the assistant-store branch
   ([`packages/tools/src/builtins-recall.ts:357`](../packages/tools/src/builtins-recall.ts))
   — robot turns would be invisible to Remy. Fix to
   `ne(channel, 'telegram')` (the dedup rationale only applies to Telegram,
   which has its own authoritative table) as part of this work.
4. Result: the robot speaks to the SAME Saskia as web + Telegram — one
   persona, one memory, digests and reflector covering robot conversations
   automatically. Voice stays the robot's problem (it has the GPU; it can
   run its own STT/TTS) or it can POST text after using Mantle's STT
   worker — start text-only.

### B2. A `converse` MCP tool (optional sugar, after B1)

Once B1's endpoint exists, the MCP `converse` tool is a thin wrapper: tool
input `{text, agent_slug?}` → run the same turn → return the reply. Two
implementation routes:

- **Cleanest:** extract the turn orchestration from `apps/web/lib/assistant.ts`
  into `@mantle/agent-runtime` (it's already 80% shared pieces —
  `loadConversationContext`, `buildChatMessages`, `runToolLoop`; the web
  file mostly does resolution + attachments + persistence glue). Then both
  the web route and `apps/mcp` call one `runResponderTurn()`. This is a
  real refactor; budget for it.
- **Pragmatic:** the MCP server HTTP-calls B1's endpoint (it cannot import
  `apps/web` — apps don't import apps). Works day one; adds an internal
  auth hop.

Mind the recursion: `converse` runs a tool loop that could in principle be
asked to call MCP again — the existing `invoke_agent` depth guards
(`MAX_AGENT_DEPTH`) are the pattern; a `converse` turn should refuse to
dispatch a nested `converse`.

## 4. Gotchas & side-quests

- **New tool/endpoint = manifest territory.** If `converse` becomes a
  builtin or the robot channel needs default grants, read
  [`docs/system-integrity.md`](./system-integrity.md) first (manifest
  drift-test + `applyManifest` gap-fill semantics).
- **Trust model interaction** ([`handover-trust-model.md`](./handover-trust-model.md),
  still open): an embodied agent ingests the physical world — overheard
  speech, other people. Robot-channel turns should carry provenance from
  day one (`external`-tier if the speaker isn't the owner) so the trust
  work lands on top cleanly, not retrofitted.
- **Docs to update when shipped:** architecture §10 (transport reality),
  conversation.md §0 channel table + §9, recall.md §6 (the channel filter),
  the README doorways table ("Robots / embodied agents" row — the
  marketing line is *"give your robot a soul that survives reboots"*; the
  website handover may want the same persona added).
- **Latency hygiene for the robot loop:** keep the agent's model on a
  `local` route (vLLM/Ollama on the H200) with a cloud backup via
  chat-failover; the per-turn DB retrieval is milliseconds — the LLM call
  dominates. Streaming the reply over B1's endpoint is the obvious v2.

## 5. Suggested sequence

1. B1 robot channel (union + parameterized channel + endpoint + auth +
   recall filter fix) — the companion works end-to-end after this alone.
2. A networked MCP (Streamable HTTP + bearer auth + compose profile) — the
   robot gains direct tool access (search, files, events…) for its own
   agency beyond conversation.
3. B2 `converse` tool — ideally riding the `runResponderTurn()` extraction.
4. Doc sweep (§4) + a README/website persona update.

## 6. Verification

- B1: `curl -H "Authorization: Bearer …" -d '{"text":"hi"}' /api/channels/robot/turn`
  twice → second reply shows memory of the first; the turns appear in
  `/assistant` with a `robot` channel badge; after 30+ turns a digest
  exists; `recall_window surface=all` replays them.
- A: `npx @modelcontextprotocol/inspector` against the HTTP endpoint;
  unauthorized request → 401; stdio path still works for Claude Desktop.
- Persona continuity: tell the robot channel a preference → reflector note
  appears → web `/assistant` exhibits it (one character across bodies).
