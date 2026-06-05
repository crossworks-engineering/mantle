# Comms channels — decouple transport from agent `role`

> **Status: BUILDING.** Phases 1–3 shipped (v0.19.4-alpha+): the generic
> `channels` table, token re-seal backfill + dual-write (Phase 1); the
> channel-driven poller registry + channel-based inbound dispatch with the
> `role='responder'` fallback removed (Phase 2); and the reflector + web-default
> role-decouple (Phase 3). Phases 4–6 (cleanup migration, Studio surface,
> Discord/Slack) per §10 below. The current-state map (§2) describes the
> pre-refactor baseline; the §12 decisions are resolved inline as each phase
> lands: **1** keep `telegram_accounts` as a 1:1 extension (not folded); **2**
> unlinked/legacy bots left channel-less; **3** `role` demoted to a hint
> (option A — no enum migration); **4** reflector gate = enabled conversational
> agent with ≥1 new outbound turn since the last run, capped at 5 agents/tick;
> **5** web default = priority-based among chat-capable agents with a soft
> assistant→responder→custom tiebreak, explicit `?agent=` still wins.

## 0. TL;DR for the builder

Today an agent can only be on Telegram if its `role = 'responder'`. That bakes
**transport** into the **identity** column (`agents.role`). The fix: a generic
**`channels`** table that *attaches* a transport (Telegram, later Discord/Slack)
to **any** agent, plus removing the three hardcoded `role='responder'` gates. The
Studio (docs/agent-studio.md) gains a "Channels" attach surface — channels become
another attachable binding alongside skills + delegates.

Build it **additively**: `channels` coexists with `telegram_accounts`, backfill,
dual-read, then cut over. Do **not** break the live prod Telegram poller (see §9).

---

## 1. Why (the problem)

`agents.role` is an enum `assistant | responder | extractor | summarizer |
reflector | custom` ([packages/db/src/schema/agents.ts:25](../packages/db/src/schema/agents.ts)).
For conversational agents only `assistant`, `responder`, `custom` matter, and
`assistant` vs `responder` are **functional peers** — identical tool loop, memory
config, persona notes. The *only* real differences are three transport/learning
gates that privilege `responder`:

| Gate | Location | Effect |
|---|---|---|
| Telegram default agent | [`apps/agent/src/main.ts:174`](../apps/agent/src/main.ts) — `eq(agents.role, 'responder')` | only a `responder` is the global default for an inbound bot message |
| Persona learning | [`apps/agent/src/reflector.ts:86`](../apps/agent/src/reflector.ts) — `role='responder'` | the reflector only learns on responders; an `assistant` never gets smarter |
| Bot ownership | `telegram_accounts.responder_agent_id` ([schema/telegram.ts:58](../packages/db/src/schema/telegram.ts)) | the token FK is named *responder* |

**The tell that this is wrong:** the system manifest's canonical persona is slug
`assistant` but **`role: 'responder'`** ([manifest.ts:153](../apps/web/lib/system-manifest/manifest.ts)).
They made the "assistant" a responder *under the hood* precisely because a true
`role:'assistant'` can't be on Telegram. The workaround is the evidence.

**Consequence:** you cannot have one agent that is a `role:'assistant'` **and**
on Telegram. Transport is an either/or property of identity. Adding Discord/Slack
would mean inventing more roles or more special-casing. That's the smell.

**Already half-decoupled (good news):** the **per-chat override**
`telegram_chats.responder_agent_id` ([schema/telegram.ts:100](../packages/db/src/schema/telegram.ts))
accepts **any** agent regardless of role — only the *global default* is
responder-locked. The data model partly anticipates this.

---

## 2. Current-state map (what exists today)

### Schema (`packages/db/src/schema/telegram.ts`)
- **`telegram_accounts`** — one row per bot: `bot_username`, `bot_token_enc`
  (AES-GCM, `MANTLE_MASTER_KEY`), `branch_path`, **`responder_agent_id`** (FK →
  agents, the binding), `last_update_offset`, `last_poll_at`, `last_poll_error`,
  `enabled`. Partial-unique on `responder_agent_id` (a responder owns ≤1 bot).
- **`telegram_chats`** — per chat: allowlist status, pairing code, **per-chat
  `responder_agent_id` override** (role-agnostic).
- **`telegram_messages`** — per message, backed by a `nodes` row; `direction`
  in/out, outbound `agent_id` provenance.

### Runtime
- **Poller:** [`apps/web/workers/telegram-poll.ts`](../apps/web/workers/telegram-poll.ts)
  — a standalone Node process. `refreshAccounts()` loads `telegram_accounts WHERE
  enabled` every 60s and spawns one long-poll loop per account (`startLoop` →
  `pollOnce(account, 25)` from `@mantle/telegram`). Single-instance assumed.
- **Inbound dispatch:** `pollOnce` → `persist()` inserts `telegram_messages` +
  `nodes` and fires `pg_notify('telegram_message_inserted')`. The agent process
  [`apps/agent/src/main.ts`](../apps/agent/src/main.ts) listens and calls
  `resolveResponderAgent(ownerId, overrideAgentId, accountResponderId)` — tries
  the per-chat override, then the bot owner, then **falls back to
  `role='responder'` (line 174)**. No responder → message skipped.
- **Token bind (UI):** `connectAgentTelegram` in
  [`apps/web/lib/agent-telegram.ts`](../apps/web/lib/agent-telegram.ts) validates
  the token via `getMe()`, seals it (`seal(token, accountId)` — **AAD bound to the
  account row id**), upserts `telegram_accounts` with `responderAgentId = agentId`.
  Surfaced by `components/telegram/telegram-bot-section.tsx` (connect + pair) on
  `/settings/agents`, routes under `/api/agents/[id]/telegram`.
- **Conversation provenance:** `assistant_messages.channel` is a
  `'web'|'telegram'|'whatsapp'` **tag** (provenance + reply-transport hint), NOT a
  binding ([schema/assistant-messages.ts](../packages/db/src/schema/assistant-messages.ts)).

### What's missing
No transport-binding table, no Discord/Slack, no generic poller registry. Telegram
is the sole, special-cased channel.

### Constraints the builder MUST respect
- **Dev/prod poller split** ([[project_telegram_dev_prod_poller_conflict]]): prod
  polls `saskianewbot`, dev polls `saskiadevbot` (no 409). The **prod poller stays
  up on deploy.** Don't introduce a migration/refactor that stops or double-runs a
  live poller.
- **Token encryption AAD:** tokens are sealed with the *row id* as AAD. If rows
  move to a new table with new ids, **re-seal** during migration (decrypt with old
  AAD, re-encrypt with new) — a raw copy of `bot_token_enc` will fail to open.
- **migrate.ts runner** ([[reference_migrate_runner]]): each migration commits in
  its own txn, replays 0001→latest, hand-written SQL + journal. Don't add+use an
  enum value in one migration file.
- **Cost-safety** ([[project_cost_safety_no_reextract_trigger]]): the reflector
  change must NOT make persona-learning run unboundedly across many agents — gate
  it on real conversation activity (§6).

---

## 3. Target architecture

A **channel** is a transport attached to an agent. Any agent can carry zero or
more. Transport stops being a function of `role`.

```
agent ──< channels >── (telegram | discord | slack | …)
                 │
                 ├─ credentials (sealed)
                 ├─ config (bot_username, branch_path, …)
                 └─ enabled
```

- **`role` stops gating transport.** It survives only as a soft web-default hint
  (or is dropped — see §7). Whether an agent is "on Telegram" = does it have an
  enabled telegram channel.
- **"Persona"** = an agent bound to a user-facing channel (retires the Studio's
  `isPersona = slug==='assistant'` magic-slug check).
- **Generic poller registry.** Each transport registers a poller; a supervisor
  spawns one per enabled channel of that type. `telegram-poll.ts` becomes the
  first registered poller, keyed by channel instead of account.
- **Reflector** runs on any conversational agent (§6), not just responders.

---

## 4. Schema (recommended)

Additive. `channels` is the new generic binding; the Telegram-specific *state*
and *data* tables stay (they hold transport-specific columns) but re-point at
`channels`.

```sql
-- New: the generic binding (one row per attached transport).
CREATE TYPE channel_type AS ENUM ('telegram');  -- add 'discord','slack' later, in their own migration
CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type            channel_type NOT NULL,
  display_name    text NOT NULL,            -- e.g. '@saskianewbot'
  credentials_enc bytea NOT NULL,           -- sealed secret, AAD = channels.id
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret transport config
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_owner_idx ON channels(owner_id);
CREATE INDEX channels_agent_idx ON channels(agent_id);
```

**Telegram mapping.** Keep `telegram_accounts` for transport-specific *poll state*
(`last_update_offset`, `last_poll_at`, `last_poll_error`, `bot_username`,
`branch_path`) but make it a **1:1 extension of a channel**: add
`channel_id uuid REFERENCES channels(id) ON DELETE CASCADE` and drop the
`responder_agent_id` semantics (the agent now lives on `channels.agent_id`). The
`bot_token_enc` moves to `channels.credentials_enc` (re-sealed). `telegram_chats`
+ `telegram_messages` keep `account_id` (now 1:1 with a channel) — no need to
rename, just ensure each account has a `channel_id`.

> **Decision for the builder:** fold `telegram_accounts` *entirely* into `channels`
> (poll-state columns onto `channels`, type-specific config in `config` jsonb) vs.
> keep it as a thin extension table. Recommended: **keep it as an extension**
> (`telegram_accounts.channel_id`) — smaller migration, leaves the poll-state and
> the `telegram_chats/messages` FKs untouched, and keeps `channels` transport-clean.

---

## 5. Migration path (additive, no big-bang, prod-safe)

1. **Add `channels` + `channel_type` enum + `telegram_accounts.channel_id`** (one
   migration each per the runner's enum rule — enum in its own migration, used in
   the next). Nullable `channel_id` first.
2. **Backfill:** for every `telegram_accounts` row with a non-null
   `responder_agent_id`, create a `channels` row (`type='telegram'`,
   `agent_id = responder_agent_id`, `display_name = '@'||bot_username`,
   `config = {bot_username, branch_path}`), **re-seal the token** (decrypt with
   `accountId` AAD → re-encrypt with the new `channels.id` AAD) into
   `channels.credentials_enc`, and set `telegram_accounts.channel_id`. Rows with
   null `responder_agent_id` (legacy/unlinked) — leave channel-less or attach to
   the highest-priority responder; **decision for builder**.
3. **Dual-read:** update the poller + resolver to read from `channels` (join
   `telegram_accounts` for poll state) while the old columns still exist. Verify
   prod parity (same bots polled, same agents resolve).
4. **Cut over + clean up:** once verified, drop `telegram_accounts.responder_agent_id`
   and the partial-unique index; the token lives only in `channels`.

Sequence the prod deploy so the running poller is never both-old-and-new at once
(see §9). Each step is independently shippable + verifiable.

---

## 6. Runtime changes

### Poller registry (`apps/web/workers/`)
Generalise [`telegram-poll.ts`](../apps/web/workers/telegram-poll.ts) into a
supervisor + per-type pollers:
- A `ChannelPoller` interface: `{ type, startLoop(channel): {stop} }`.
- Registry: `{ telegram: telegramPoller }` (Discord/Slack later).
- Supervisor `refreshChannels()` loads `channels WHERE enabled` (join the type's
  state table), groups by `type`, and spawns/stops loops per channel — same
  60s-refresh + backoff shape as today. Telegram's `pollOnce` stays; it just takes
  a channel + its `telegram_accounts` state row instead of a bare account.

### Inbound dispatch (`apps/agent/src/main.ts`)
Replace `resolveResponderAgent`'s **`role='responder'` global fallback (line 174)**
with channel-based resolution: the inbound message arrives on a known channel →
**that channel's `agent_id`** handles it; the **per-chat override still wins**.
No `role` lookup. Channels always carry `agent_id`, so there's always an answer.

### Reflector (`apps/agent/src/reflector.ts`)
Drop the `role='responder'` filter (line 86). Run persona-learning on any agent
with **real conversation activity** — gate on "has an enabled channel OR has N
recent `assistant_messages`", NOT "all agents" (cost-safety, §2). **Decision for
builder:** exact gate.

### Web `/assistant` default (`apps/web/lib/assistant.ts`)
`resolveAssistantAgent` currently prefers `role='assistant'` then `role='responder'`
([lines 110/119](../apps/web/lib/assistant.ts)). After decoupling, make the default
**priority-based** among conversational agents (drop the role preference, keep
explicit-slug + priority). Keep back-compat: an explicit `?agent=` still wins.

---

## 7. `role` after the refactor

`assistant`/`responder` no longer mean anything for transport. Options
(**decision for builder**, recommend **A**):
- **A. Demote to a hint:** keep the column, stop gating on it; `role` becomes a
  loose label (default web pick by priority). Lowest churn, no enum migration.
- **B. Collapse** `assistant`+`responder` → a single `conversational` role
  (migration + backfill). Cleaner long-term, more churn.

Either way, update `system-manifest`: the persona entry can become a plain
conversational agent, and the Studio's `isPersona` check becomes "has a
user-facing channel" / highest-priority conversational — retiring the
`slug==='assistant'` magic ([[project_system_integrity]] persona.ts).

---

## 8. The Studio surface (UI)

This is the "additional screen attached to an assistant" — it lives in **Agent
Studio's structure layer** (docs/agent-studio.md, Phase 3). Per focused agent, a
**Channels** section:
- List attached channels (type, display name, enabled, health).
- Attach a channel → pick type → enter credentials → for Telegram, reuse the
  existing **connect + pair** flow (`components/telegram/telegram-bot-section.tsx`,
  `/api/agents/[id]/telegram`) generalised to write a `channels` row.
- Detach / enable / disable.

Until the Studio surface lands, the existing `/settings/agents` Telegram section
keeps working against `channels` (it's the same connect+pair flow, just writing
the new table).

---

## 9. Non-goals, safety, prod

- **Don't break the live prod poller.** Prod runs a standing Telegram poller for
  `saskianewbot` ([[project_telegram_dev_prod_poller_conflict]]). The poller
  refactor must deploy such that exactly one poller polls each bot across the
  switch — backfill `channels` *before* the new poller reads it, and don't run old
  + new pollers against the same token simultaneously (Telegram 409).
- **Re-seal tokens** on migration (§2) — never raw-copy `bot_token_enc`.
- **No new LLM triggers/crons** (cost-safety). The reflector gate must bound which
  agents learn.
- **Scope:** ship Telegram-on-channels first (parity). Discord/Slack are *enabled*
  by this architecture but are separate follow-ups (each = a registered poller +
  a `channel_type` enum value + a credentials/config shape).

---

## 10. Phased build plan

1. **Schema + backfill** — `channels` + enum + `telegram_accounts.channel_id`;
   backfill with token re-seal; dual-write from `connectAgentTelegram`. (Verify:
   every existing bot has a channel row; tokens still open.)
2. **Poller registry** — generalise `telegram-poll.ts` to read `channels`; verify
   dev bot still polls, prod parity. Cut the resolver (`main.ts`) to channel-based
   dispatch; remove the `role='responder'` fallback.
3. **Reflector + web-default decouple** — drop the two remaining `role` gates
   (reflector, `resolveAssistantAgent`); add the activity gate.
4. **Cleanup migration** — drop `telegram_accounts.responder_agent_id` + its index.
5. **Studio Channels surface** — attach/detach UI per agent; retire `isPersona`
   magic-slug. (Pairs with Agent Studio Phase 3.)
6. **(Later)** Discord/Slack as new registered pollers + enum values.

Phases 1–4 deliver the architecture (any agent on Telegram, role decoupled); 5 is
the UI; 6 is the payoff (new transports).

---

## 11. File-reference index (what to touch)

| Concern | File |
|---|---|
| Agent role enum | `packages/db/src/schema/agents.ts:25` |
| Telegram schema (migrate) | `packages/db/src/schema/telegram.ts` |
| New `channels` schema | `packages/db/src/schema/channels.ts` (new) |
| Migrations | `packages/db/src/migrations/` (+ journal; see [[reference_migrate_runner]]) |
| Poller | `apps/web/workers/telegram-poll.ts` → registry |
| Poll logic | `packages/telegram/src/sync.ts` (`pollOnce`, `persist`) |
| Inbound dispatch / resolver | `apps/agent/src/main.ts:154-178` |
| Reflector gate | `apps/agent/src/reflector.ts:86` |
| Web default pick | `apps/web/lib/assistant.ts:92-124` |
| Token bind flow | `apps/web/lib/agent-telegram.ts` (`connectAgentTelegram`, `seal`) |
| Bind UI | `apps/web/components/telegram/telegram-bot-section.tsx`, `apps/web/app/api/agents/[id]/telegram/` |
| Studio attach surface | `apps/web/app/(app)/studio/` (docs/agent-studio.md Phase 3) |
| Canonical docs | `docs/telegram.md`, `docs/architecture.md` §9/§9b, `docs/conversation.md` |

---

## 12. Open decisions for the build session

1. `telegram_accounts` → fold into `channels` vs. keep as 1:1 extension (recommend **extension**).
2. Legacy unlinked bots (null `responder_agent_id`) — attach to top responder vs. leave channel-less.
3. `role` — demote to hint (**A**) vs. collapse to one conversational role (**B**).
4. Reflector activity gate — exact predicate for "which agents learn".
5. Web `/assistant` default — pure priority vs. keep a soft role tiebreak.
