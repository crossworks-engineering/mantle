# Team Chat — tokenized Contacts chat with the brain

> **Status: BUILT** (v0.117.0, 2026-07-06; Phases 1+2 of the plan). Team members
> — Contacts holding a team token — chat with the brain through a
> permission-limited responder at `/team`. They can ask anything the brain
> knows; they can never modify anything. Change requests become tasks in an
> owner review queue. Every turn is audited and navigable from the owner's
> `/team-admin` screen. **Phase 3 (open):** MS Teams adapter over the same
> bearer-token API; per-contact long API secret.
>
> Companion docs: [`contacts.md`](./contacts.md) (the team-member role lives on
> Contacts), [`security.md`](./security.md) (threat model + guarantees),
> [`sharing.md`](./sharing.md) + the app-share section of
> [`app-authoring-guide.md`](./app-authoring-guide.md) (the other consumer of
> team tokens), [`system-integrity.md`](./system-integrity.md) (how the
> team-responder is provisioned and drift-checked).

---

## 1. The model in one paragraph

Team membership is a **role a Contact holds**, not a user account. A live row in
`contact_team_tokens` *is* the role: it stores the SHA-256 of a short
shown-once token (8 chars, look-alike-free alphabet) minted from `/contacts`.
That token is the only credential a member ever has, and it admits them to two
surfaces: **team-mode app shares** (`/s/<token>` — see the app-authoring guide)
and **Team Chat** (`/team`). Deleting the token row — via the toggle, or by
deleting the contact — revokes everything at once, mid-session, because every
request re-checks membership liveness.

The brain/team is the **trust boundary** (standing design preference): a team
member can read what the team responder can read. There are no in-brain tiered
read ACLs — finer secrecy means deploying a separate brain. The one deliberate
carve-out is the owner's *private corpus* (email + journal), which is excluded
by default (§6).

## 2. Surfaces

| Surface | Who | What |
|---|---|---|
| `/team` | member | Token gate → forever-thread chat with the brain: composer, attachments, live streaming. Outside the app shell; in `PUBLIC_PATHS`. Since v0.126.0 the thread uses the assistant chat's TURN layout (reply as a left-canvas document, the member's question as a sticky right-margin card, live status labels) — see the header comment in `components/team-chat/team-chat-client.tsx` for what is deliberately NOT ported (rich dialect, thought trail, tool ledger). |
| `/team-admin` | owner | Sidebar **Team** entry. Chats tab: member index by recent activity with unread badges, read-only thread preview, per-turn `/traces` deep links. Requests tab: open team requests with reply / mark-done. Recent access log. Header switch for private reads (§6). |
| `/api/team/*` | member (cookie or bearer) | The machine API — the same routes the web surface uses, so a future MS Teams adapter is a thin client, not a rebuild. |

## 3. Auth

- **Token → cookie exchange:** `POST /api/team/auth` verifies the team token
  and mints a signed brain-level cookie (claim kind `k:'c'`, path `/`). Dual
  rate limits (per-IP with hardened `clientIp`, per-brain), **uniform 401** for
  missing-share and wrong-token alike (no oracle), every attempt access-logged.
- **Bearer:** `Authorization: Bearer <team token>` is accepted directly on
  `/api/team/*` — the adapter path.
- **Liveness:** `resolveTeamChatCaller` re-checks membership on *every*
  request. Revocation is immediate — no session outlives the token row.
- `last_used_at` on the token is bumped only after the owner match, so a token
  presented to a *different* brain's link never pings home.

## 4. Turn pipeline

`POST /api/team/turn` (JSON or multipart) → per-contact rate limit + a
`TEAM_CHAT_DAILY_TURNS` daily cap (denials are access-logged) → enqueue the
durable `TEAM_TURN_WORKFLOW` on the shared DBOS runner queue → the member
subscribes to the SSE stream (`/api/team/turn/[turnId]/stream`, replay-merged
via `turn_stream_buffer`).

Isolation properties, enforced server-side:

- **Turn ids are minted server-side** as `team-<contactId>.<nonce>` and used
  for both the workflow id and the stream id. The stream route rejects unless
  the embedded contact equals the authenticated caller — a member can neither
  construct nor tail another member's turn even with a leaked id, and owner
  turns (bare UUIDs) are unreachable from the team stream route entirely. The
  client's nonce rides along for retry dedup, but the client can never choose
  the contact half.
- **`runTeamTurn`** is a sibling of `runAssistantTurn` with the owner context
  stripped: no persona notes, no conversation digests, no journal injection.
  History comes from the member's *own* team thread only. Traces carry
  `subject_kind: 'team_turn'` + the contactId.
- **Streaming is deliberately unfiltered** (decision 2026-07-05): members see
  the same live status narration the owner sees. Transparency within the trust
  boundary — a member can see what was consulted even when the answer omits it.
- Input is clamped (20k chars on both the JSON and multipart paths).
- Uploads land under `/files/team-uploads/<date>` with provenance
  `data.source = 'team:<contactId>'` — team-contributed content is always
  distinguishable after ingestion.

## 5. The team responder (manifest-provisioned)

Agent `team-responder` + tool group `team-read` are declared in the system
manifest, so fresh installs seed them and existing brains converge on upgrade
(links reconcile by role). A drift-guard test locks the group's shape:
**read-only brain-wide + exactly one write tool**, with `export_node`,
`recall_window`, and all delegation excluded.

The one write tool is **`team_request_create`**: it wraps task creation but
stamps provenance (contactId, thread message, attachments) **from the surface,
never from model args** — so every team-originated task is visibly
team-originated even under prompt injection, and the worst-case injection
outcome is a mislabeled task in a human-reviewed queue.

Owner-side, a `team-admin` tool group on the persona adds
`team_chat_list` / `team_chat_read` / `team_access_list`, so the *owner's*
assistant can answer "what has Sam asked about this week?" from the audit
trail.

## 6. Private reads — email + journal are off by default

Team members always get brain-knowledge reads (notes, pages, tables, files,
search), but the owner's **email and journal** are off-limits unless the owner
opts in:

- Profile pref `teamPrivateReads`, **default OFF**.
- Enforced at tool resolution in `runTeamTurn` — `email_*` / `journal_*` slugs
  are stripped from the resolved tool set when off, *independent of the group
  grant*, so a manifest change can't silently re-expose them.
- The owner switch lives on the `/team-admin` header; **enabling** requires an
  `AlertDialog` confirm that spells out the blast radius (disabling is
  immediate, no confirm).

## 7. Data model

Migrations 0114 + 0115:

- **`team_messages`** — per-contact forever-thread (direction, text, agent,
  model, channel `web|api|msteams`, attachments, `trace_id`, status). Contact
  FK **CASCADE**: deleting the contact deletes the conversation (deletion =
  revocation, per the multi-admin precedent).
- **`team_access_log`** — auth / turn / api / denied events. Contact FK **SET
  NULL**: the audit trail outlives the person.
- **`team_read_cursors`** — the owner's per-thread unread markers (composite
  PK, CASCADE); unread counts fold into the member index via a correlated
  subquery.

Team turns are **not** semantically indexed into `content_chunks` — the brain
reaches them via the owner-side tools (§5), keeping team chatter out of the
memory corpus unless explicitly promoted. (Uploaded *files* do ingest, with
provenance — that's the point of "please update X, attached".)

## 8. Request → task → reply loop

1. Member asks for a change → responder calls `team_request_create` → a task
   tagged `team-request` with full provenance.
2. Owner works the **Requests** tab on `/team-admin` (or the tasks screen
   filtered by tag) — the human review surface. Open-request count badges the
   tab.
3. **Reply** posts the owner's answer straight into the member's thread
   (`notifyTeamRequester`; stamps `notifiedAt`, optional mark-done). The loop
   closes in the same channel the request came from.

Deliberate split: **tasks are the human review queue; `pending_tool_calls`
stays the agent tool-execution gate.** Team requests never touch the pending
queue directly.

## 9. Rate & cost controls

- Per-contact turn rate limit + `TEAM_CHAT_DAILY_TURNS` daily cap (denials
  logged with kind `denied`).
- Auth is rate-limited per-IP + per-brain.
- Traces carry `cost_micro_usd` per turn, so per-contact spend is queryable
  today; a hard per-contact cost cap is Phase-3 material.

## 10. Testing

The suite locks the security-relevant behaviour: credential kind-isolation
(team-chat cookies vs app-share cookies vs owner sessions), turn-id
mint/parse + cross-member isolation, the private-reads default-off resolver
(exact gated-slug set + strip behaviour), `team_request_create` provenance
shape, history mapping, and a manifest drift-guard asserting `team-read` stays
read-only with the one write tool. ~1889 tests green at ship.
