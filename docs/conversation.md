# Unified conversation stream

**Status: DESIGN (not yet built).** This doc is the plan-on-paper for collapsing
every chat channel — web `/assistant`, Telegram, future WhatsApp — into a single
per-agent conversation store. It's meant to be refined before any code lands.

Companion docs:
- [`architecture.md`](./architecture.md) §9b (Telegram responder), §9g (web
  `/assistant`), §9b' (digests) — the *current*, pre-unification shape.
- [`recall.md`](./recall.md) — "Remy" reads `conversation-digest` notes; the
  digest re-keying below must not break her `find_window`.
- [`ai-workers.md`](./ai-workers.md) §5 — the `summarizer` worker that this plan
  reduces from two entry points to one.

---

## 0. The problem

Today every chat channel forks the entire stack. Two channels exist and they
duplicate four things each:

| Concern | Telegram | Web `/assistant` |
|---|---|---|
| Conversation store | `telegram_messages` (keyed per **chat**) | `assistant_messages` (keyed per **owner+agent**) |
| History load | `loadContext` reads `telegram_messages` by `chat_id` ([main.ts:327](../apps/agent/src/main.ts)) | `loadContext` reads `assistant_messages` by `agent_id` ([assistant.ts:218](../apps/web/lib/assistant.ts)) |
| Digests | `summarizeChat(chatPk)` → notes keyed `data.chat_id` | `summarizeWebConversation(ownerId)` → notes `source:web` |
| Summarize trigger | `summarize_due` on `telegram_messages` INSERT, payload `chat_id` ([0013](../packages/db/migrations/0013_conversation_digests.sql)) | `summarize_web_due` on `assistant_messages` INSERT, payload `owner_id` ([0044](../packages/db/migrations/0044_web_summarize_due.sql)) |
| Brain node per message | yes (`type=telegram_message`) | no |
| Attachments | `telegram_messages.attachments` (file_ids) | ephemeral artifacts only — not persisted |

Adding WhatsApp means a *fifth* copy of all of that. Three things make this worse
than it looks:

1. **Every channel re-implements memory.** History loading, digest production, the
   summarize trigger, and the prompt-build context are copy-pasted per channel and
   drift independently.
2. **The web summarizer is already per-*owner*, not per-*agent*** — a latent
   inconsistency with the "one stream per agent" goal, and the web responder passes
   `digests: []` so it never even reads its own digests back.
3. **There is no single place to *see* a conversation.** A turn sent on Telegram
   never appears on `/assistant` and vice-versa, even though both are "the same
   assistant."

## 1. The goal

> For each agent, all comms — whatever channel they arrive on — end up in **one**
> conversation stream. The `/assistant` window for that agent shows everything
> (text, voice, images, from any channel). Exactly **one** summarizer runs over that
> stream. A single source of truth per agent.

Channels stop being pipelines and become **transports**: thin adapters that receive
on a wire, handle their own delivery concerns, and read/write the shared stream. The
responder, the summarizer, and the UI never know which channel a turn came from.

## 2. Target architecture

```
                ┌─────────────── transports (delivery + wire only) ───────────────┐
   web POST ───▶│  web        telegram-poll        whatsapp-poll (future)          │
                └───────────────┬───────────────────────┬─────────────────────────┘
                                ▼ recordTurn()           ▼ recordTurn()
                   ┌──────────────────────────────────────────────────┐
                   │  assistant_messages  (per owner+agent, +channel)   │ ◀ single source of truth
                   └───────────────┬───────────────────┬──────────────┘
                    INSERT trigger ▼                    ▼ loadConversationContext()
                  pg_notify('summarize_due', agent_id)  │
                                   ▼                     ▼
                   summarizeAgentConversation()    runToolLoop()  ─ reply ─▶ transport.send()
                                   ▼
                   conversation-digest notes (tagged by agent_id)
```

**Two axes, cleanly separated:**

- **Conversation + memory axis** — `assistant_messages`. Cross-channel, per agent.
  Owns history, digests, and display. This is the source of truth.
- **Transport + brain axis** — `telegram_messages` (and a future `whatsapp_messages`).
  Owns dedup (`update_id`), threading (`message_id`), delivery state, attachment
  `file_id`s, and the `type=telegram_message` brain node. Stays channel-specific.

The two are linked by a back-reference (`assistant_messages.external_ref`), but the
responder/summarizer/UI only ever touch `assistant_messages`.

### Why keep `telegram_messages` at all?

Because it does jobs the conversation stream shouldn't: Telegram-specific dedup,
delivery retries, the `file_id`s needed to download a voice clip, and the per-message
brain node that makes an individual Telegram line findable by search. Per the design
decision (2026-06-03), raw-message **node-backing stays as-is** — the brain axis is
unchanged. The conversation stream is a *separate, additional* write, not a
replacement. This is a deliberate dual-write (see §7 Risks).

## 3. Schema change

Migration `0071_unified_conversation.sql`. Extend `assistant_messages`
([schema](../packages/db/src/schema/assistant-messages.ts)) — chosen over a rename to
`conversation_messages` to keep the blast radius small (existing `/assistant` code,
indexes, recall queries keep working):

```sql
ALTER TABLE assistant_messages
  ADD COLUMN channel      text  NOT NULL DEFAULT 'web',   -- 'web' | 'telegram' | 'whatsapp'
  ADD COLUMN attachments  jsonb NOT NULL DEFAULT '[]',    -- [{kind,url?,mime?,caption?,nodeId?,fileId?}]
  ADD COLUMN external_ref jsonb;                          -- {accountId,chatId,messageId,updateId}

CREATE INDEX assistant_messages_owner_agent_channel_created_idx
  ON assistant_messages (owner_id, agent_id, channel, created_at);
```

- **`channel`** — drives the UI badge and which transport sends an outbound reply.
- **`attachments`** — what makes voice/images render in `/assistant`. Shape maps onto
  the existing `Artifact` type the chat already renders
  ([assistant-client.tsx `ArtifactView`](../apps/web/app/\(app\)/assistant/assistant-client.tsx)).
- **`external_ref`** — lets the Telegram sender thread replies and lets us
  dedup/back-link to the transport row without a join table.

### Trigger swap

A single trigger on the unified table replaces both existing ones. Because *every*
channel now writes `assistant_messages`, one trigger covers all of them, keyed on the
stream identity (`agent_id`):

```sql
CREATE OR REPLACE FUNCTION notify_summarize_due() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('summarize_due', NEW.agent_id::text); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assistant_messages_summarize_due_trg
  AFTER INSERT ON assistant_messages FOR EACH ROW
  EXECUTE FUNCTION notify_summarize_due();

DROP TRIGGER IF EXISTS telegram_messages_summarize_due_trg ON telegram_messages;
DROP TRIGGER IF EXISTS assistant_messages_summarize_web_due_trg ON assistant_messages;
-- the `summarize_web_due` channel is retired
```

> **Cost-safety note.** Per [MEMORY: cost-safety / no-reextract-trigger], this trigger
> only ever `pg_notify`s — it never itself runs an LLM. The summarizer's own
> threshold check (undigested < N) remains the gate that decides whether a model is
> actually called. No runaway risk introduced.

## 4. Shared conversation module

New file `packages/agent-runtime/src/conversation.ts` — the single read/write API both
surfaces call. This dedups the two near-identical `loadContext` copies.

```ts
recordTurn({ ownerId, agentId, channel, direction, text, model?, attachments?, externalRef? })
  → inserts one assistant_messages row, returns it.

loadConversationContext({ ownerId, agent, inboundText, queryVec? })
  → { personaNotes, facts, contentHits, digests, history }
     history = assistant_messages WHERE owner+agent, last N turns, ALL channels, chronological
     digests = conversation-digest notes WHERE data.agent_id = agent.id
```

The "per-agent, cross-channel" semantics live here. The digest filter changes from
`data.chat_id = chatPk` (Telegram) / `source = 'web'` (web) to a uniform
`data.agent_id = <agent>`.

## 5. Per-surface changes

### 5a. Web (`apps/web/lib/assistant.ts`)
- `loadContext` → call `loadConversationContext` (it now also returns real digests,
  closing the current `digests: []` gap for free).
- Inbound/outbound inserts → `recordTurn(channel='web', attachments=[image artifact])`.
- Pass real `digests` into `buildChatMessages`. Lowest-risk surface (same table).

### 5b. Telegram (`apps/agent/src/main.ts` + `workers/telegram-poll.ts`)
- **Keep** the `telegram_messages` insert (node, dedup, file_ids, delivery).
- **Add** `recordTurn(channel='telegram', externalRef={chatId,messageId,updateId},
  attachments=[…])` for both inbound and outbound, in the *same transaction* as the
  telegram_messages write.
- `loadContext` → `loadConversationContext` (per-agent, cross-channel). Digests by
  agent, not chat.
- Outbound reply still sends via the bot (`sendMessage`/`sendVoice`), threading off
  `external_ref.messageId`. Voice/photo out are also recorded as `attachments` so they
  appear on `/assistant`.
- *Open question to confirm in build:* exact inbound `recordTurn` site — the poll
  worker (row exists even before the agent processes it) vs. `handleMessage`. Leaning
  poll worker.

### 5c. Summarizer (`apps/agent/src/summarizer.ts`)
- Collapse `summarizeChat(chatPk)` + `summarizeWebConversation(ownerId)` into one
  **`summarizeAgentConversation(ownerId, agentId)`** reading
  `assistant_messages WHERE owner+agent AND digest_node_id IS NULL`.
- Digest notes tagged `conversation-digest` + `agent:<id>`; `source` kept only as
  informational metadata, not a query key.
- Mark turns digested via `assistant_messages.digest_node_id`
  (`telegram_messages.digest_node_id` goes vestigial).
- `main.ts`: one `summarize_due` LISTEN handler keyed on `agentId`; delete
  `summarize_web_due` + `scheduleSummarizeWeb`.

### 5d. `/assistant` UI
- `recentAssistantMessages` / `assistantMessagesBefore` + the messages API return
  `channel` + `attachments`.
- [assistant-client.tsx](../apps/web/app/\(app\)/assistant/assistant-client.tsx): map
  `attachments` → the existing `Artifact` shape (already renders `<audio controls>` +
  image preview); add a small channel badge on non-web turns.
- Telegram voice notes need a playable URL — served via the existing
  attachment-download route off the stored `file_id` / node id.

## 6. Backfill (one-time)

`scripts/backfill-conversation.ts`, dry-run by default (same convention as
`dedupe:edges`):
- For each `telegram_messages` row, insert a matching `assistant_messages` row
  (`channel='telegram'`, `agent_id` resolved from `chat.responder_agent_id` → account
  → priority; map direction/text/attachments/`external_ref`; preserve `sent_at` →
  `created_at`).
- **Idempotent**: skip rows whose `external_ref.messageId` already exists.
- **Don't storm the trigger**: insert with the summarize trigger disabled (or a
  `backfill` short-circuit) so the backfill doesn't fire thousands of `summarize_due`
  notifies.
- **Re-key existing digests**: stamp `data.agent_id` onto pre-existing
  `conversation-digest` notes (they currently carry `data.chat_id` / `source`), or the
  responder briefly loses old digests after cutover.

## 7. Risks & call-outs

- **Multiple Telegram chats on one agent interleave** in the single stream. For the
  single-user setup (one bot per responder, DMs only) this is correct and desired —
  noted, not partitioned.
- **Dual-write transactionality** — Telegram writes both `telegram_messages` and
  `assistant_messages`; wrap in one transaction so a crash can't half-record a turn.
- **Digest re-keying** — see §6; old digests must gain `agent_id` or be migrated.
- **Recall / `find_window`** — Remy reads `conversation-digest` notes
  ([recall.md](./recall.md)). The tag stays (`conversation-digest`), so matching should
  hold, but verify her queries don't rely on `data.chat_id` / `source` before cutover.
- **`flattenChatMessagesForAdapter`** rejects multimodal/tool messages; the summarizer
  path stays single-turn text, so unaffected — but worth a regression check.

## 8. Sequencing

Phases 0–5 are the core shippable arc; 6–7 are migration + cleanup. Suggested order,
committing per phase on `main` with `pnpm --filter @mantle/web run typecheck`:

```
0  schema + trigger swap          0071_unified_conversation.sql
1  shared module                  packages/agent-runtime/src/conversation.ts
2  web onto shared module         apps/web/lib/assistant.ts            (web works end-to-end)
4  one summarizer                 apps/agent/src/summarizer.ts + main.ts LISTEN
3  Telegram cutover               apps/agent/src/main.ts + telegram-poll.ts
5  UI: channel badge + attachments apps/web/.../assistant-client.tsx
6  backfill + digest re-key       scripts/backfill-conversation.ts
7  docs                           promote this file from DESIGN → as-built; update architecture.md §9b/§9g
```

(Web before Telegram so the shared module is proven on the lower-risk surface first.)

## 9. Proof the abstraction holds — WhatsApp later

A new channel needs only: a poll/webhook worker that calls
`recordTurn(channel='whatsapp', …)`, and a send function keyed off `external_ref`.
**No** new conversation table, **no** new summarizer, **no** new history-loader, **no**
`/assistant` change beyond a badge glyph. That is the entire payoff of this refactor.
</content>
</invoke>
