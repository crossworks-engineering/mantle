# Heartbeats — proactive Saskia

Heartbeats are how an agent acts *without being prompted*. Instead of
the user asking and Saskia replying, a heartbeat row schedules Saskia
to **initiate** — ask a question, send a nudge, run a checklist —
and remember her state across firings until the goal is met.

The metaphor in one sentence: **a heartbeat is a standing instruction
with a schedule, a memory, and a stop condition.**

```
heartbeats (when + where + state)
   └─→ skill   (what to do, with which tools)
         └─→ agent  (whose voice, model, persona)
                └─→ surface (telegram chat / web inbox)
```

This doc covers the data model, lifecycle, gates, the worked
"get_to_know_user" example, the conventions skills follow, and the
soft-fail catalog. Cross-refs: [`architecture.md` §9j](./architecture.md)
for the high-level fit; [`ai-workers.md`](./ai-workers.md) for the
adapter framework heartbeats use to talk to providers.

## 1. Data model

Migration `0030_heartbeats.sql` adds two tables and one enum value.

### `heartbeats`

| column              | type                            | notes                                              |
|---------------------|---------------------------------|----------------------------------------------------|
| `id`                | uuid                            | PK                                                 |
| `owner_id`          | uuid → auth.users               | scoping                                            |
| `slug`              | text (unique per owner)         | stable handle e.g. `get_to_know_user`              |
| `name`              | text                            | human label                                        |
| `description`      | text                            | optional                                           |
| `agent_slug`        | text                            | resolved to `agents.slug` at fire time             |
| `skill_slug`        | text                            | resolved to `skills.slug` at fire time             |
| `schedule_kind`     | enum (once/interval/cron/manual)| `cron` reserved for v1.1; not implemented yet      |
| `schedule`          | jsonb                           | shape varies by kind, see §2                       |
| `next_fire_at`      | timestamptz                     | computed; null when status ≠ active                |
| `last_fired_at`     | timestamptz                     | populated after every fire (including errors)      |
| `fire_count`        | integer                         | only successful fires bump this                    |
| `max_fires`         | integer                         | null = unbounded                                   |
| `surface`           | jsonb                           | `{kind:'telegram',chat_id:...}` or `{kind:'web'}`  |
| `min_idle_minutes`  | integer NULL                    | gate: skip if user just messaged                   |
| `quiet_hours`       | jsonb NULL                      | `{from:'HH:MM',to:'HH:MM',tz:?}`; tz null = profile|
| `earliest_at`       | timestamptz NULL                | hard floor before any fire                         |
| `cooldown_minutes`  | integer NULL                    | gate: min wait between fires of THIS heartbeat     |
| `state`             | jsonb                           | the skill's running memory; see §10 + §11          |
| `status`            | enum (active/paused/completed/cancelled) |                                            |
| `completion_reason` | text                            | free-text, e.g. `tool_call:all_topics_covered`     |

**Per-heartbeat-only gates.** There are no system-wide defaults.
A null gate column means "no check of that kind". The UI form offers
a "sensible defaults" preset (15/22-07/30) but the DB stays explicit.

### `heartbeat_fires`

One row per fire attempt — whether it actually ran or was gated. The
detail page renders this as a chronological audit log without
exploding the `traces` table (gate skips happen often, traces are
precious).

`trace_id` is populated for any disposition that opened a trace
(everything except auto-pause). It's a bare uuid column, NOT a FK —
heartbeats outlive trace pruning, and a dangling reference is
preferable to either keeping traces forever or losing the audit row.

Disposition vocabulary (operator triage at-a-glance, distinct colours
on `/heartbeats/[id]`):

| Disposition | Colour | Meaning |
|---|---|---|
| `fired` | emerald | LLM ran AND reply reached the surface (happy path) |
| `completed` | sky | Same as fired, but a tool flipped `status=completed` (heartbeat met its goal) |
| `fired_undelivered` | orange | LLM ran + reply text computed, but the surface refused (no enabled Telegram account; `sendMessage` threw). LLM cost was spent; user got nothing. State still updated. P1-1 fix. |
| `skipped_idle` / `skipped_quiet` / `skipped_cooldown` / `skipped_earliest` | amber | Gate rejected. No work, no cost. |
| `auto_paused` | rose | Config error caught BEFORE any LLM work (agent missing, skill missing, key undecryptable). Heartbeat moved to `status=paused` — operator must intervene. P1-2 split. |
| `error` | purple | Transient runtime failure mid-fire. Will retry on the next tick after a short backoff. Distinct from `auto_paused` so the operator can tell "will fix itself" from "I need to look at this". |

### trace_kind extension

`trace_kind += 'heartbeat_fire'`. Subject = the heartbeat row.
Standard trace machinery (cost rollup, step graph, subject linking)
just works. `/traces?kind=heartbeat_fire` filters in one click;
trace detail pivots to `/heartbeats/[id]` via the subject link.

## 2. Schedule shapes

```ts
type Schedule =
  | { kind: 'once';     at: string /*ISO*/ }
  | { kind: 'interval'; every_minutes: number; jitter_minutes?: number }
  | { kind: 'cron';     expr: string /*5-field*/ }  // v1.1
  | { kind: 'manual'                        };       // only via heartbeat_fire tool
```

`jitter_minutes` is small but matters — keeps fires from feeling
mechanical (asking the same question at exactly 09:00:00 every day
reads as a bot, not a peer). The jitter seed is `${id}:${fireCount}`
so a flaky retry reproduces the same offset.

`cron` is intentionally not implemented in v1. The enum reserves it
for forward-compat; `computeNextFireAt` throws if you try to use it.
The UI form silently coerces `cron` rows to `manual` on edit — known
data-corruption risk for power users who insert cron rows via SQL
(v1.1 fix: surface a banner instead).

## 3. The fire loop

`apps/agent/src/main.ts` runs `tickHeartbeats(USER_ID)` on a 60-second
`setInterval` with the same exponential-backoff pattern the reflector
uses (cap 30min). Each tick:

```
SELECT * FROM heartbeats
 WHERE owner_id = $1
   AND status = 'active'
   AND next_fire_at IS NOT NULL
   AND next_fire_at <= now()
 ORDER BY next_fire_at
 LIMIT 10
```

then filters out rows in `isFireInflight(id)` — the in-process
`Map<id, Promise>` lock in `packages/heartbeats/src/inflight.ts`.
This is what stops the next tick from re-firing a slow heartbeat
that's still mid-LLM-call (the schedule's `next_fire_at` doesn't
update until the fire completes, ~30-90s of vulnerable window).

For each eligible row:

1. **Gate check** (`checkGates`). On fail: write a `heartbeat_fires`
   row, soft-skipped trace, bump `next_fire_at` forward conservatively,
   return.
2. **Resolve agent + skill + API key**. Missing/disabled? Auto-pause
   the heartbeat with `status='paused'` and reason
   `auto_pause:<detail>`. Operator must re-enable.
3. **Open trace** (`startTrace({kind:'heartbeat_fire', subject_id:hb.id})`)
   and capture the trace id (stamped onto `heartbeat_fires.trace_id`).
4. **Compose system prompt**: agent's persona + persistent skills +
   time-context line. The HEARTBEAT skill is NOT in here — it goes
   into the user-role synthetic prompt below.
5. **Build synthetic user prompt** (`buildHeartbeatPrompt`):
   identity + state JSON + (if `state.expecting_reply` already true,
   the stale-pending nudge) + skill instructions + control-tool
   reminder + last_asked_at convention pointer.
6. **Run tool loop** wrapped in `withHeartbeatContext` so the control
   tools default their addressing to this heartbeat. Tool allowlist =
   agent.toolSlugs ∪ persistentSkills.toolSlugs ∪
   heartbeatSkill.toolSlugs ∪ heartbeat-control tools.
7. **Deliver reply** to surface inside a `step({name: 'deliver_surface',
   kind: 'send'})` so a Telegram outage shows up distinctly in the
   trace graph (not buried inside the surrounding LLM step).
8. **Reload heartbeat** to capture any state mutations from tools.
9. **Compute next_fire_at** via `computeNextFireAt`, **preserving any
   snooze** (`heartbeat_snooze` pushes `next_fire_at` further out;
   the final UPDATE keeps the further-future value over the schedule's
   natural one).
10. **Check `max_fires`** for auto-completion.
11. **Persist** and **record fire** to `heartbeat_fires` with
    state-before/after + the trace id.

Step 8 is critical: a `heartbeat_complete` call mid-loop must stop
the next fire from being scheduled. Step 9's snooze-preservation is
the P0-1 fix from the v1 audit — without it, snooze was silently
clobbered.

## 4. The 5 control tools

Live in `packages/heartbeats/src/tools.ts` (not `@mantle/tools` —
would create a dependency cycle). `registerHeartbeatTools()` runs at
agent boot, before `seedBuiltinTools()`.

### Addressing (where the heartbeat to act on comes from)

The three mutation tools have **dual-mode addressing**:

```
explicit `slug` arg  →  ALS context (fire path)  →  error
```

- **Inside a heartbeat fire**: omit `slug`, the `withHeartbeatContext`
  ALS provides the default. Ergonomic for skill authors.
- **From a normal responder turn** (the user replied to a previously-
  asked heartbeat question): pass `slug` explicitly. The awareness
  block injected into the responder's system prompt tells the model
  exactly which slug to pass.
- **Ownership scoping** holds in both paths — a slug from one owner
  can never resolve to another's row.

Tool-by-tool:

| Tool                       | Required args | Addressing |
|----------------------------|---------------|------------|
| `heartbeat_complete`       | —             | slug or ALS |
| `heartbeat_snooze`         | `for_hours` or `until` | slug or ALS |
| `heartbeat_update_state`   | `patch`       | slug or ALS |
| `heartbeat_list`           | —             | no addressing (lists all) |
| `heartbeat_fire`           | `slug`        | slug only (force-fire by id) |

Each tool's failure modes are surfaced as a `branch: '...'` value on
the trace step's `meta` (no_target / bad_patch_shape / bad_delay /
updated / completed / snoozed). Silent diagnostic — no console
noise, but `/traces` shows exactly which path the call took.

### Permission model & runtime hygiene

`agents.tool_slugs` is the **single source of truth** for which tools
an agent can call. There is no auto-injection: if Saskia is meant to
update heartbeat state from a responder turn, the heartbeat continuity
tools (`HEARTBEAT_RESPONDER_TOOLS` =
`heartbeat_update_state` + `heartbeat_complete` + `heartbeat_snooze`)
must be in her `tool_slugs` allowlist (visible at `/settings/agents`).

The seed script `seed-get-to-know-user.ts` calls
`ensureHeartbeatToolsOnAgent()` to add them idempotently to the
auto-detected responder agent (reads the canonical
`HEARTBEAT_RESPONDER_TOOLS` constant from `@mantle/heartbeats` so
the grant list never drifts from the auto-exclusion list below).
Custom heartbeats not seeded this way need the operator to grant
the tools manually via the UI.

The three mutation tools all self-protect via `resolveTargetHeartbeat()`
— calling them with no slug and no ALS context returns a clean
"no heartbeat context" error. So they're inert in unrelated turns;
adding them to an agent's allowlist persistently is safe.

**Runtime affordance hygiene** (auto-exclusion): even though the
operator granted these tools, the responder loops drop them from the
per-turn tool list when `hasActiveHeartbeatsOnSurface()` returns
false. The model never *sees* them when there's nothing for them to
do — eliminates the small but real noise of the model confusedly
calling a heartbeat tool on a turn with no relevant heartbeat. The
grant in `tool_slugs` stays canonical; only the per-turn affordance
is scoped to context. This is the mirror image of auto-injection
(which would *grant* affordances the operator didn't): hiding what's
useless is fine, granting what wasn't asked for is not.

`heartbeat_list` + `heartbeat_fire` are NOT auto-excluded — they're
operator/skill tools that make sense any time (e.g., "what
heartbeats do you have for me?", "fire that one now").

## 5. The continuity trick

If a heartbeat asks the user a question and the user replies an hour
later, that reply hits the *normal* responder turn — not the heartbeat
fire loop. So how does Saskia stay in character?

The responder, on every turn, calls `openHeartbeatsForSurface(ownerId, surface)`
which returns active heartbeats for this surface where
`state.expecting_reply` is truthy. If non-empty, an awareness block
gets appended to the system prompt via `buildOpenHeartbeatContext`:

```
## Open heartbeats

You have one or more proactive tasks awaiting replies on this surface.
**Decide per message which branch applies:**

**1. If the user's message answers a heartbeat question** → respond
naturally, then call `heartbeat_update_state` with the heartbeat's
`slug` and a patch like `{ answered: [...prior, '<topic>'],
expecting_reply: false }` to capture what they told you. Call
`heartbeat_complete` with the slug if the skill's goal is met.

**2. If the user's message is unrelated** → just answer them normally.
**Leave the heartbeat alone — do NOT call any heartbeat_* tool this
turn.** The heartbeat will check back on its own schedule.

**3. If the user asks you to stop or says "not now"** → call
`heartbeat_snooze` (defer with `for_hours`) or `heartbeat_complete`
(stop permanently) with the relevant slug. Acknowledge their wish.

Pending heartbeats:
- `get_to_know_user` (Get to know the user) — asked 2h ago. State: {...}
```

The "asked 2h ago" suffix comes from `state.last_asked_at` — a skill-
level convention (see §11) that the prompt builder surfaces so the
model can reason about staleness when picking between "soft re-ask"
and "give them space."

**Why this matters**: it keeps the heartbeat skill's full instructions
out of every regular turn (~1KB savings per turn for an 8-topic
interview skill) while preserving continuity. The full skill returns
on the next heartbeat fire.

### The relevance gate (commit `1502a0d`)

The "Leave the heartbeat alone" branch is the load-bearing piece.
Without explicit "do NOT call" wording, models treat the visible tool
list as a menu and reach for it — calling `heartbeat_update_state`
with empty arrays when the user asked about the weather, or re-asking
the heartbeat question on top of answering the weather. Both feel
broken to the user. The explicit branch tells the model: if the
incoming message isn't a reply, do absolutely nothing heartbeat-shaped
this turn.

## 6. The worked example: `get_to_know_user`

Seeded by `apps/web/scripts/seed-get-to-know-user.ts`. **Fires once,
~6 hours after install** (with a small random jitter so it doesn't
always land at exactly 6h), sends a single warm invitation, and
self-terminates on the user's first substantive reply. That's the
whole script.

The skill (`profile_interview`) state shape is tiny — just enough to
power the awareness block on the inbound reply:

```ts
{
  expecting_reply: boolean,    // true after asking, false on complete
  last_asked_at: string,       // ISO instant (drives "asked Nh ago")
}
```

Lifecycle:

```
T+0      Operator runs the seed script.
         - Skill 'profile_interview' upserted with the simplified
           one-invitation instructions + default_state.
         - Responder agent's tool_slugs ensured to include the 3
           heartbeat continuity tools.
         - Heartbeat 'get_to_know_user' created with
             schedule: { once, at: now() + ~6h }
             max_fires: 1
             gates: 5min idle / 22-07 quiet
             state: { expecting_reply: false }

T+~6h    The single 'once' fire triggers (gates passing).
         Saskia composes ONE warm invitation, e.g. "Hey 🌿 — quick
         one: tell me a bit about yourself? Whatever you'd like me
         to remember." Calls heartbeat_update_state with
           { expecting_reply: true, last_asked_at: '<now>' }
         Reply delivered via Telegram. trace_id stamped on
         heartbeat_fires.

T+~7h    Alex replies with what he wants to share (family / role /
         whatever). The reply hits the NORMAL responder turn —
         openHeartbeatsForSurface returns the get_to_know_user row,
         3-branch awareness block injected, Saskia matches "related
         answer", acknowledges warmly, calls
           heartbeat_complete(slug: 'get_to_know_user',
                              reason: 'opened_relationship')
         Status → 'completed', next_fire_at → null. Never fires again.

         Meanwhile, in the background:
         - Extractor creates entities (Mia, Ben, Zoe, …) +
           facts ("Alex lives in Barrydale", …) from the message
         - Reflector eventually appends persona_notes summarising
           the relationship

         The heartbeat opened the door; everything downstream that
         actually "knows" Alex was passively absorbed by the
         existing pipelines.
```

**If Alex ignores the invitation**: heartbeat stays
`expecting_reply: true` forever, no nagging. If he engages organically
later (mentions his family in passing), the responder's awareness
block still fires on that turn, Saskia closes the heartbeat then. If
he explicitly declines ("not now"), Saskia calls `heartbeat_complete`
with reason='user_declined'.

### Why this design replaced the original 8-question interview

The original design fired daily for 8 days, asking one topical question
per fire (family / work / hobbies / health / weekend / goals / …).
Tested every state-persistence + multi-fire path in the engine. Also
felt like an interrogation — exactly the wrong vibe for an AI that's
supposed to know you, not interview you.

Two design failures in that v1:
1. **The system already learns passively.** Extractor harvests entities
   + facts from every message. Reflector appends persona notes. The
   heartbeat doesn't need to drive the learning — it just needs to
   open the door. Asking 8 questions duplicated work the rest of the
   system was already doing for free.
2. **Multi-fire pestering risk.** Even with the relevance gate + stale-
   pending nudge, asking the same person N more questions over N more
   days felt like a CRM, not a friend.

The simplified one-question design is the canonical demo. The engine
still supports the multi-fire pattern for skills that genuinely need
it (e.g., a hypothetical "daily standup" or "weekly review"), but
that's a different shape of feature, not the get-to-know-you flow.

## 7. Soft-fail catalog (real bugs we've already paid for)

Lessons collected from the v1 dogfood — keep this list updated as
new symptoms surface.

- **Dual-mode addressing was the v1 latent bug.** Original tools
  required `withHeartbeatContext` ALS to address the target
  heartbeat. The responder turn handling a user's reply has no
  such context (different lifecycle). The awareness block told
  the model to "call heartbeat_update_state" but the tool refused
  with `branch: 'no_context'`. Fixed in `0de3a9e` — tools now
  accept `slug` and fall back to ALS only when slug is absent.

- **`tsx --watch` doesn't reliably reload workspace packages.**
  After rapid commits to `packages/heartbeats`, the agent process
  may run partially-stale code (some modules from disk, some
  cached). Symptom: trace says success but DB didn't update;
  restart fixes it. **Operator habit: manually restart `apps/agent`
  after any change in `packages/heartbeats/`.** No code fix planned;
  this is a dev-tooling characteristic, not a runtime bug.

- **`traces.agent_id` FK to `agents.id`** (not `ai_workers`, not
  `heartbeats`). The fire orchestrator stores agent_id correctly;
  if you add a future trace path that uses a different uuid, it'll
  throw a silent FK violation (the tracing layer is fire-and-forget).
  Same trap that bit extractor/summarizer/reflector — see
  `observability.md` §12.

- **Auto-pause on missing config** beats silent retries. If the
  agent row is deleted or the API key disappears, the next tick
  marks the heartbeat `paused` rather than throwing every minute.
  The operator sees a paused status and a `completion_reason`
  starting with `auto_pause:` and knows where to look.

- **Heartbeat reload before update.** Step 8 of the fire loop
  re-SELECTs the heartbeat before persisting next_fire_at, because
  a tool call inside the loop may have already mutated the row
  (e.g. `heartbeat_complete` set status=completed). A blind update
  would clobber that.

- **Snooze preservation in the final UPDATE** (P0-1). If
  `heartbeat_snooze` pushed `next_fire_at` further out than the
  schedule would naturally compute, the final UPDATE keeps the
  snooze's value. Without this, snooze was silently overwritten
  by the schedule.

- **In-flight lock** (P0-2). Without `runWithInflightLock`, a
  fire taking longer than the 60s tick interval would be re-selected
  by the next tick and double-fire (duplicate trace, duplicate
  Telegram message, double LLM cost). The lock holds per-process;
  multi-process deployments would need a Postgres advisory lock
  (single-process today).

- **Gate skips don't bump `fire_count`.** Otherwise quiet-hours
  would burn through `max_fires` for an unbounded heartbeat without
  the user ever hearing from Saskia.

- **Permission model — `agents.tool_slugs` is the source of truth.**
  Heartbeat continuity tools must be in the responder agent's
  `tool_slugs` for the responder→state update path to work. The
  seed script handles this; custom heartbeats need manual grant.
  We briefly auto-injected the tools per-turn; that violated the
  "tools live in tool_slugs" contract and was reverted.

- **Runtime affordance hygiene — auto-exclusion.** Even with the
  three continuity tools granted persistently, the responders drop
  them from the per-turn tool list when zero active heartbeats
  exist on the surface (`hasActiveHeartbeatsOnSurface()` returns
  false). The grant stays canonical; only the affordance is
  scoped. Mirror image of auto-injection — hiding useless tools is
  fine, granting un-granted ones is not. Means a completed/paused
  install is byte-indistinguishable from a system that never had
  heartbeats: the model never sees the tools, can't call them,
  can't be confused by them.

## 8. Operator surfaces

- `/settings/heartbeats` — list, create/edit, pause/resume, fire-now,
  delete. Per-heartbeat gate preset radio (none / sensible / custom).
- `/heartbeats/[id]` — detail with current state JSON, gates summary,
  recent fire log (50 most recent) with trace links.
- `/traces?kind=heartbeat_fire` — every fire (and gate-skip) under
  the normal trace browser. Subject link pivots back to the heartbeat
  detail page.
- `/settings/skills` — skills CRUD (the skill that backs a heartbeat
  is edited here). **Caveat**: the skills list doesn't yet show which
  heartbeats reference each skill, so deleting a skill that's bound
  to a heartbeat will auto-pause the heartbeat on its next fire
  attempt (config error → auto_pause). v1.1: surface the binding.

## 9. Out of scope for v1

Named so we don't accidentally do them:

- **Cron schedules.** Enum value reserved; add `cron-parser` when needed.
  UI form currently coerces cron rows to manual on edit (v1.1: banner instead).
- **Multi-agent collaboration mid-fire.** A heartbeat picks one agent
  via `agent_slug`. Need delegation? Use the existing `invoke_agent`
  builtin from inside the fire — that's already wired.
- **Cross-surface heartbeats** (start on web, finish on telegram).
- **User-driven snooze via Telegram keyword** (e.g. `/later`).
- **Heartbeat template library.** v1 expects hand-crafted entries
  through the UI / seed script.

### Low-latency wake via pg_notify (NEW-7, shipped)

Default tick interval is 60s, so a heartbeat created via `/settings/heartbeats`
with `next_fire_at` in the immediate future would wait up to a full
minute before the tick loop picked it up. Felt like a bug to the
operator (click "Create", nothing happens).

`packages/heartbeats/src/notify.ts` adds `notifyHeartbeatDue(ownerId)`
which fires `pg_notify('heartbeat_due', <ownerId>)`. Producers:

  - `apps/web/lib/heartbeats.createHeartbeat` after every insert
  - `apps/web/lib/heartbeats.updateHeartbeat` after every update
    (covers schedule edits + resume-from-paused)

Consumer: `apps/agent/src/main.ts` LISTENs on `heartbeat_due` and
calls `tickHeartbeats(ownerId)` on each notification — same code path
as the 60s setInterval, just kicked early. Net effect: an operator's
Create/Edit/Resume click lands in the trace within ~1s, not 60s.

Soft-failing on both sides. `notifyHeartbeatDue` swallows errors
(next regular tick catches up). The listener swallows handler errors
too. The 60s setInterval remains as the floor — losing a single
notify is at most a 60-second UX regression, never a correctness
issue.

The web's `fireNowAction` (Zap button) does NOT use `notify` — it
calls `forceFire` directly in the Next.js server-action process, so
the trace appears immediately. The two paths don't overlap.

### Catch-up spike after agent downtime (NEW-6)

When `apps/agent` is down for an extended period (host reboot, deploy,
crash + auto-restart), every heartbeat whose `next_fire_at` passed
during the outage becomes "due" simultaneously. On boot, the tick
selects up to `TICK_BATCH=10` due rows per minute and fires them
sequentially.

Worst case: agent down for an hour, 50 heartbeats due in that window
→ on resume, 10 fire in the first minute, 10 in the next, etc. — a
5-minute flurry. For a single-user install with a handful of
heartbeats this is invisible; at scale (dozens of frequently-firing
heartbeats), it could feel like a notification storm.

Mitigations (not implemented in v1, named here for the v1.1
discussion):

  - Lower `TICK_BATCH` to spread the flurry over more minutes
  - Detect `now() - next_fire_at > stale_threshold` and **bump
    forward** instead of firing the stale one (treat as missed-bus)
  - Coalesce per-surface: don't send N Telegram messages in 2 minutes
    even if N heartbeats are due — let the user breathe

For the dogfooded single-user scenario today, none worth doing. Worth
knowing exists for capacity planning.

## 10. Initial state — `skills.default_state` + heartbeat override

Migration 0031 adds `skills.default_state jsonb` so skill authors can
declare the expected starting shape once. Heartbeat creation flow:

1. Operator picks a skill in the create form
2. `state` textarea auto-populates from `skills.default_state` (only
   if the textarea hasn't been manually touched yet — protects
   in-progress edits when switching skills)
3. Operator can edit the JSON freely; client + server both validate
   that it's a plain object (not array, not primitive)
4. On submit, the heartbeat's own `state` column gets that value

Once a heartbeat exists, its `state` is the source of truth — edits
to the skill's `default_state` do NOT propagate to existing
heartbeats (it's a template, not a live reference). The skills CRUD
form has its own `default_state` textarea so authors can declare
what their skill needs.

Example: `profile_interview` skill seeded with:

```json
{
  "answered": [],
  "expecting_reply": false
}
```

Every heartbeat using `profile_interview` starts there unless the
operator overrides. The `last_question_topic` + `last_asked_at`
keys appear as the skill runs and the model populates them via
`heartbeat_update_state`.

## 11. Conventions: well-known state keys

`heartbeats.state` is free-form jsonb — the engine writes to it
(only via tools, never directly) but doesn't validate the shape.
Skills are responsible for the vocabulary. The following keys are
**read by engine code** (prompt builder, tick query) so renaming
them in skills breaks behaviour silently. Treat them as a shared
contract between the engine and skill authors:

| Key                   | Type     | Read by | Purpose |
|-----------------------|----------|---------|---------|
| `expecting_reply`     | boolean  | `openHeartbeatsForSurface` (tick.ts) + stale-pending detector (prompt.ts) | Truthy means a fire asked something and is waiting. Gates the awareness-block injection on responder turns. |
| `last_asked_at`       | ISO string | `lastAskedAgo` helper (prompt.ts) | Surfaces "asked Nh ago" in awareness block + stale-pending nudge. |
| `last_question_topic` | string   | (display only, surfaced in awareness block state JSON) | Operator visibility + skill self-reference. |
| `answered`            | string[] | (display only) | Skill-defined; convention is "topics already covered" for interview-style skills. |

Skill conventions beyond these four (anything else the skill's
instructions reference) are local to the skill — keep them
namespaced ("interview_questions_remaining", "checklist_step",
etc.) to avoid future collisions.

There's no TypeScript type for these today; it's a documentation
contract. A `WellKnownStateKeys` type re-exported from
`@mantle/heartbeats` would catch typos at the skill-author layer
without forcing a schema change — v1.1 candidate.

## 11b. Skill design — prefer one focused fire over an interrogation

Drawn from the get_to_know_user redesign. When you're tempted to
ship a heartbeat with a multi-fire skill, ask:

1. **Does the rest of the system already learn this passively?**
   Extractor + reflector harvest entities, facts, and persona notes
   from every message. If your heartbeat's goal is "build a profile
   of the user", the heartbeat just needs to open the door — the
   passive pipelines do the real work. A long script duplicates them
   AND feels like a CRM.

2. **Does each fire add genuinely new value, or just churn?**
   A daily check-in adds value (today's mood is different from
   yesterday's). An 8-day interview where each fire asks one more
   topic is just N invasive pings stretched across N days. The user
   doesn't experience them as separate — they experience them as
   "this thing keeps bothering me."

3. **Could one well-crafted fire achieve 80% of the goal?**
   Usually yes. A single warm open-ended invitation gets the user
   sharing in their own shape and pace. The engine's relevance gate
   means unrelated turns leave the heartbeat alone; the responder's
   awareness block means a delayed reply still closes the loop.
   Reach for the multi-fire pattern only when each fire's content
   is meaningfully fresh.

**Pattern checklist for a well-designed heartbeat skill:**

  - Single clear fire goal stated in the instructions
  - State shape is minimal (often just `{expecting_reply, last_asked_at}`)
  - Self-terminates on a clear completion signal (first substantive
    reply / user_declined / max iterations reached)
  - Schedule reflects intent: `once` for one-shot, `interval` only
    when each fire genuinely covers new ground
  - Tone matches a friend, not a survey

The complex multi-fire flow stays available in the engine for skills
that earn it (daily check-ins, weekly reviews, multi-step
onboarding). It just isn't the default shape — design for one good
fire first, only branch out if you can defend why.

## 12. Skills: two activation models, one table

`skills` predates `heartbeats` (migration 0023 vs 0030). Originally
it was just "instructions + tools you can attach to an agent."
Heartbeats reuse it for the "what to do" axis. The same `skills`
row can be referenced in two ways:

| Activation | Set via | Lifetime | Use case |
|---|---|---|---|
| Always-on | `agents.skill_slugs[]` | Loaded into system prompt of EVERY turn that agent runs | Persistent behaviour packs ("format dates as en-GB", "use spoken style on voice notes") |
| Situational | `heartbeats.skill_slug` | Loaded only into the synthetic user prompt during the fire | "Topics to cover in get_to_know_user" |

A skill referenced both ways would be injected twice (once in the
system prompt, once in the fire's synthetic user prompt). Slightly
wasteful, never broken. In practice: persistent skills should be
short ("how to format dates") and heartbeat skills should be
specific ("interview the user across these 8 topics"). Don't mix.

The composition helpers `composeSystemPromptWithSkills` and
`effectiveToolSlugs` live in `packages/agent-runtime/src/skills.ts`
and are used by both the responder turn (always-on) and the
heartbeat fire (situational).

## 13. Files

| Path                                            | Purpose                                  |
|-------------------------------------------------|------------------------------------------|
| `packages/db/migrations/0030_heartbeats.sql`    | Schema + enum extension                  |
| `packages/db/src/schema/heartbeats.ts`          | Drizzle types                            |
| `packages/heartbeats/src/schedule.ts`           | `computeNextFireAt` + `validateSchedule` |
| `packages/heartbeats/src/gates.ts`              | `checkGates` (idle / quiet / cooldown / earliest) |
| `packages/heartbeats/src/prompt.ts`             | Synthetic prompt + open-heartbeat block + last_asked_at age helper |
| `packages/heartbeats/src/context.ts`            | AsyncLocalStorage for current heartbeat  |
| `packages/heartbeats/src/inflight.ts`           | Per-process `Map<id, Promise>` lock (P0-2) |
| `packages/heartbeats/src/fire.ts`               | Single-fire orchestration (inflight lock + snooze preservation + state reload) |
| `packages/heartbeats/src/tick.ts`               | Tick loop + `openHeartbeatsForSurface`   |
| `packages/heartbeats/src/tools.ts`              | 5 builtin control tools (dual-mode addressing) |
| `apps/agent/src/main.ts`                        | Tick wiring + responder context inject   |
| `apps/web/lib/heartbeats.ts`                    | CRUD lib                                  |
| `apps/web/app/(app)/settings/heartbeats/*`      | CRUD UI                                  |
| `apps/web/app/(app)/heartbeats/[id]/page.tsx`   | Detail / fire log                        |
| `apps/web/scripts/seed-get-to-know-user.ts`     | Demo skill + heartbeat + tool grant      |
| `apps/web/scripts/test-fire-heartbeat.ts`       | Diagnostic CLI: one-shot forceFire to compare in-process vs long-running agent |
