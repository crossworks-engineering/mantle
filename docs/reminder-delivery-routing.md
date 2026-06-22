# Reminder delivery routing — sticky last-channel + mobile push

> **Status: IN PROGRESS.** Landed on branch `feat/reminder-channel-routing`:
> the enabling change + last-channel tracking + `reminderChannel` profile pref
> (foundation), the reminder worker mobile branch (B), and quiet-hours removal
> (C — `isQuietNow` gating gone, `push/quiet-hours.ts` deleted, `quiet_*` +
> `timezone` columns dropped via migration `0095`). Mobile reminders are now
> gated only by the `assistantMessages` push toggle. Also landed: web profile UI
> + API (D) — a "Reminder delivery" selector on `/settings/profile` plus a
> mobile-facing `GET/PUT /api/profile/reminder-channel`. **Server side is
> COMPLETE.** It is the design for letting event/reminder notifications reach the
> **Mantle Companion** mobile app (not just Telegram), routed by the user's most
> recently used communication channel, with a profile-level override. Written
> 2026-06-21; deployed in v0.29.0.
>
> **Decision (2026-06-22): the in-app channel toggle (E) is dropped — by design,
> not pending.** Picking "Telegram" from inside the Mantle app is self-defeating
> (if you want Telegram, message Telegram). The channel already auto-follows the
> last surface you used, and the **web** profile selector covers the rare explicit
> override, so an in-app picker adds no value. The ONLY remaining companion-side
> work is **removing the app's now-dead quiet-hours UI** (its server backing was
> dropped in `0095`). A future enhancement may have a mobile reminder schedule a
> local OS notification/alarm at `remind_at` so it fires actively without
> depending on a live push or the app being open (see §"mobile = passive" below).
>
> **Terminology guard.** This doc uses "channel" in the
> `ConversationChannel` sense — the per-turn enum
> (`'web' | 'telegram' | 'whatsapp'`) on `assistant_messages.channel`. That is
> **not** the `channels` *table* from [comms-channels.md](comms-channels.md),
> which models transport/bot accounts. We extend the enum here; we do not touch
> the `channels` table.

## TL;DR

- Today reminders are **hardcoded to Telegram** and silently dropped if there's
  no allowed Telegram DM ([events-reminders.ts](../apps/web/workers/events-reminders.ts)).
  The mobile push pipeline exists but only fires on assistant replies + pending
  approvals ([push-notify.ts](../apps/web/workers/push-notify.ts)).
- Goal: reminders follow the **last communication method**
  (Telegram or mobile), overridable from the profile. The override naturally
  holds until the next message on a different channel supersedes it.
- **Blocker found:** the server cannot currently tell a mobile-app message from a
  web-browser message — both record `channel: 'web'`
  ([assistant.ts:240](../apps/web/lib/assistant.ts)), even though mobile
  requests are bearer-authenticated and *could* be distinguished
  ([auth.ts `getBearerUser`](../apps/web/lib/auth.ts)). There is also no
  "last channel" tracking anywhere. Both are new primitives this plan adds.
- Quiet hours are **removed** as part of this work — OS-level DND covers it for a
  mobile app.

## The model

There is no separate "auto vs. manual preference" state to reconcile. The profile
holds **one** field — the current reminder channel — and:

1. Every inbound message on a **reminder-capable** channel (`telegram` or
   `mobile`) writes that channel into the field.
2. A manual change from the profile UI is just a write to the same field.
3. Therefore a manual choice holds **until the next message on a different
   channel** overwrites it. No extra "locked" flag is needed.

Synchronous **replies** already follow the last channel by nature — a reply goes
back where the message arrived (Telegram → Telegram, web/mobile → SSE stream). The
new behavior only matters for **proactive** messages: reminders today, possibly
agent-initiated messages later.

### Decisions baked in

- **Web browser is not reminder-capable.** A browser can't receive an
  out-of-band reminder, so using the web UI does *not* change the reminder
  channel — only `telegram`/`mobile` do. Default stays `telegram` for existing
  users (backward-compatible).
- **Quiet hours removed entirely** — gating, schema, and UI. OS DND covers it.
- **Reminders reuse the existing `assistantMessages` push toggle** for v1. A
  dedicated `reminders` toggle can be split out later if wanted.

## Current state (baseline)

| Concern | Where | Note |
|---|---|---|
| Reminder dispatch | [events-reminders.ts:123-168](../apps/web/workers/events-reminders.ts) `tick()` | 30s poll; `findReminderChat()` is Telegram-only; no target ⇒ logged + skipped |
| Reminder formatting | [events-reminders.ts:99-121](../apps/web/workers/events-reminders.ts) `formatReminder()` | |
| Due query | [events.ts:357](../packages/content/src/events.ts) `listDueReminders()` | `remind_at <= now()`, `reminder_sent_at is null` |
| Channel enum | [assistant-messages.ts:10](../packages/db/src/schema/assistant-messages.ts) | `'web' \| 'telegram' \| 'whatsapp'` — no `mobile` |
| Turn recording | [conversation.ts:183-215](../packages/agent-runtime/src/conversation.ts) `recordTurn()` | `channel` defaults to `'web'` |
| Web/mobile inbound | [assistant.ts:235-243](../apps/web/lib/assistant.ts) | hardcodes `channel: 'web'` for both |
| Mobile auth | [auth.ts `getBearerUser`/`getSessionUser`](../apps/web/lib/auth.ts) | bearer vs cookie, but auth method is never surfaced to the turn |
| Profile prefs | [profile-preferences.ts:23](../packages/content/src/profile-preferences.ts) | `ProfilePreferences`; `reminderAgentSlug` precedent (no UI) |
| Profile storage | [profiles.ts:9-17](../packages/db/src/schema/profiles.ts) | jsonb `preferences` column |
| Push send | [notify.ts](../apps/web/lib/push/notify.ts) `pushOutbound()`, `pushApproval()` | gated by `assistantMessages`/`approvals` + quiet hours |
| Push worker | [push-notify.ts](../apps/web/workers/push-notify.ts) | `LISTEN conversation_changed` + `pending_changed` |
| Device lookup | [store.ts `listSubscriptions`](../apps/web/lib/push/store.ts) | by `ownerId` |
| Quiet hours | [quiet-hours.ts `isQuietNow`](../apps/web/lib/push/quiet-hours.ts), [push.ts:66 `pushPrefs`](../packages/db/src/schema/push.ts) | to be removed |

**Definitive finding:** the server cannot today tell that the most recent user
message came from the mobile app vs. a web browser. Both are `channel: 'web'`;
auth method is not recorded; mobile token id is not attached to the turn.

## Enabling change — distinguish mobile from web

This is the unlock everything else depends on, and the riskiest piece (it touches
the core conversation layer).

1. Add `'mobile'` to `ConversationChannel`
   ([assistant-messages.ts:10](../packages/db/src/schema/assistant-messages.ts)).
   `channel` is a text column — **no DB migration**, just a type widening plus
   updating any exhaustive `switch`/checks on the enum.
2. Surface "authenticated via mobile bearer" from
   [getSessionUser/getBearerUser](../apps/web/lib/auth.ts) up through
   `runAssistantTurn`, and set `channel: 'mobile'` (instead of the hardcoded
   `'web'`) at [assistant.ts:240](../apps/web/lib/assistant.ts) when the request
   is mobile-bearer-authenticated.

## Workstreams

### A. Last-channel tracking
- Add `reminderChannel?: 'telegram' | 'mobile'` to `ProfilePreferences`
  ([profile-preferences.ts](../packages/content/src/profile-preferences.ts));
  unset ⇒ treated as `'telegram'`. Add the validated getter/setter, mirroring
  `reminderAgentSlug`.
- Auto-update at a single choke point: in `recordTurn()`
  ([conversation.ts:183](../packages/agent-runtime/src/conversation.ts)), when
  `direction === 'inbound'` and `channel ∈ {telegram, mobile}`, write it to the
  owner's profile. One place covers web/mobile (assistant.ts) and Telegram
  (agent `main.ts`) inbound paths. (Check the agent-runtime → content import
  direction is acceptable; if not, do the write at the two call sites instead.)

### B. Reminder delivery (worker) — DONE
In `tick()` ([events-reminders.ts](../apps/web/workers/events-reminders.ts)),
branch on the effective `reminderChannel`:
- `telegram` (and the default/unset) → existing `findReminderChat()` +
  `sendMessage()`. Unchanged.
- `mobile` → record an **outbound assistant turn** (`channel: 'mobile'`) with
  `formatReminder(evt)` text, attributed to the `reminderAgentSlug` persona (when
  set + enabled) else the owner's web-default agent (`resolveReminderAgent`, a
  local lightweight mirror of `resolveAssistantAgent`). The existing
  `conversation_changed → pushOutbound` pipeline then delivers the push **and**
  the reminder appears in the app's chat thread (deep-links to `/chat/<agent>`).

**Why record a turn rather than a dedicated `pushReminder()`:** the app is
chat-centric; a bare ephemeral notification has nowhere to land on tap. Recording
a turn reuses the seal/relay pipeline, gives chat visibility, and matches Telegram
semantics (where the reminder genuinely is a message in the thread).

**Correctness:**
- `markReminderDone` (shared by both branches) is called **after** a successful
  send/record; a failure leaves `reminder_sent_at` null so the next tick retries.
- Recurrence rolls forward **exactly once** per event (`markReminderDone` →
  `rollForwardRecurrence` for recurring, `markReminderSent` for one-shots).
- **"No enrolled device" resolved:** because the recorded turn *is* the delivery
  (it lands in the conversation stream the app reads), a mobile reminder is never
  lost even with zero push devices — it shows in the thread on next open, and the
  push is a best-effort nudge on top. So the worker marks done unconditionally on
  a successful record; no device check or Telegram fallback. The only mobile skip
  is when the owner has **no enabled chat agent at all** (can't record a turn) —
  logged, left unsent, retried.

### C. Strip quiet hours — DONE
- Removed `isQuietNow` checks from `pushOutbound`/`pushApproval`
  ([notify.ts](../apps/web/lib/push/notify.ts)); deleted `push/quiet-hours.ts`
  (+ its test); narrowed the `PushResult.skipped` union (no more `'quiet_hours'`).
- Dropped `quiet_enabled`/`quiet_start`/`quiet_end`/`timezone` from `pushPrefs`
  ([push.ts](../packages/db/src/schema/push.ts)) via migration
  `0095_drop_push_quiet_hours.sql`; cleaned `PushPreferences`/`getPushPrefs`
  ([store.ts](../apps/web/lib/push/store.ts)) and the sanitizer (+ test).
- **Heartbeat quiet hours are untouched** — that's a separate, unrelated feature
  (`HeartbeatQuietHours`, `packages/heartbeats`).
- Still to remove (under E): the companion app's quiet-hours UI. Harmless until
  then — the sanitizer now silently drops any `quiet_*` fields the app sends.

<details><summary>Original plan</summary>

- Drop `quiet_enabled`/`quiet_start`/`quiet_end`/`timezone` from `pushPrefs`
  ([push.ts:66](../packages/db/src/schema/push.ts)) + the sanitizer
  ([preferences-sanitize.ts](../apps/web/lib/push/preferences-sanitize.ts)) +
  the `/api/push/preferences` route — a migration to drop the columns.
- Remove the quiet-hours UI from the companion app
  (`lib/features/settings/push/notifications_screen.dart`).

</details>

### D. Web profile UI + API — DONE
- Web: a "Reminder delivery" `Select` (Telegram | Mobile app) on
  `/settings/profile` ([profile-client.tsx](../apps/web/app/(app)/settings/profile/profile-client.tsx)),
  defaulting to the effective value (`reminderChannel ?? 'telegram'`), persisted
  through the existing `updatePreferencesAction`
  ([actions.ts](../apps/web/app/(app)/settings/profile/actions.ts)) — guarded by
  `isReminderChannel` so only valid values are written.
- Mobile API: `GET/PUT /api/profile/reminder-channel`
  ([route.ts](../apps/web/app/api/profile/reminder-channel/route.ts)),
  owner-gated with a JSON 401 (`getOwnerOr401`, like `/api/push/*`) and a zod
  `enum(['telegram','mobile'])` body. GET returns the current effective channel.
  The Edge middleware already admits any matched route to a valid mobile bearer,
  so no allowlist change was needed.

### E. Companion app (`~/Projects/mantle-companion`)
- "Reminder delivery" control in `notifications_screen.dart` reading/writing the
  new profile pref via a new method in the push/profile data layer.
- Deep-link reuses `/chat/<agent>` — no new routing.
- Copy: mobile reminders require push to be enabled/enrolled.

### F. Tests
- Worker: telegram vs. mobile routing; "mobile selected, no device ⇒ not marked
  sent"; recurrence-once.
- `recordTurn` auto-updates `reminderChannel` for telegram/mobile inbound,
  ignores web.
- A mobile-bearer request records `channel: 'mobile'`.
- Companion controller test for the toggle (ProviderContainer + mocktail).

## Edge cases

- **New user, web-only.** `reminderChannel` stays default `telegram`, but no
  Telegram DM exists ⇒ reminders held/skipped (current behavior). Acceptable.
- **`assistantMessages` push disabled.** Mobile reminders are suppressed in v1
  (they ride `pushOutbound`'s gate). Split a `reminders` toggle later if this
  bites.
- **Both Telegram and mobile recently used.** Last one wins — that's the whole
  point. No "both" fan-out in v1.

## Sequencing

1. `'mobile'` channel tag (enabling change).
2. Last-channel auto-update in `recordTurn` (A).
3. Worker mobile branch (B).
4. Strip quiet hours (C).
5. Web API + UI (D).
6. ~~Companion toggle (E).~~ **Dropped by design (2026-06-22)** — see the status
   note at the top. Remaining companion work is only removing the dead
   quiet-hours UI.
7. Tests alongside each step (F).

Steps 1–5 + F land in this repo and shipped in v0.29.0. The only outstanding
work is the companion's dead-quiet-hours-UI cleanup in `~/Projects/mantle-companion`.

## Open questions

- ~~Confirm `recordTurn` (agent-runtime) may import profile-preferences
  (content), or do the last-channel write at the two inbound call sites.~~
  **Resolved:** the write lives at the two inbound call sites
  ([assistant.ts](../apps/web/lib/assistant.ts) for web/mobile, agent
  `main.ts` for telegram) via `noteInboundChannel`, keeping `recordTurn` pure
  and avoiding a new agent-runtime → content dependency edge.
- Whether to drop the quiet-hours `pushPrefs` columns now (migration) or leave
  them dormant and just stop reading them. *(Still open — part of workstream C.)*
