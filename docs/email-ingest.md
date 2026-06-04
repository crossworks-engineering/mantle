# Email ingestion

How email enters Mantle, gets deduplicated, and reaches the brain. This is the
canonical reference for the inbound subsystem; companion to
[`email-send.md`](./email-send.md) (outbound via SMTP submission) and
[`architecture.md §8`](./architecture.md#8-email-pipeline) (the one-paragraph view).

> **The big idea:** *never ingest mail you didn't ask for.* Sender curation is
> the gate; once a sender is `allowed`, the message lands as a `nodes` row
> exactly like a note or a file, the `node_ingested` trigger fires, and the
> extractor indexes it. Mail is just another node type from that point on.

---

## 1. The model

Three persistent shapes:

| Table | Purpose |
|---|---|
| `email_accounts` | One row per mailbox. IMAP host/port/secure + SMTP knobs + `imap_config_enc` (AES-GCM-sealed app password) + per-account include/exclude folder lists + `sync_state` jsonb (per-folder cursor) + `last_sync_at` / `last_sync_error`. |
| `email_senders` | Address → status (`pending` / `allowed` / `denied`). The security gate — only `allowed` mail reaches the brain. UI at `/settings/senders`. |
| `emails` | One row per ingested message. Companion to a `nodes` row of type `email`. Two unique keys (see §4). |

Plus `email_attachments` (one row per attachment, deduped by sha256 across the
brain via file-node sharing).

---

## 2. The worker — pg-boss queues + scheduler

`apps/web/workers/email-sync.ts` is a separate Node process during `pnpm dev`.
Three queues, all in the `pgboss` Postgres schema (jobs survive restarts):

| Queue | Cadence | What it does |
|---|---|---|
| `mantle.email.scheduler` | **every 2 min** (`*/2 * * * *`) | Fan-out: enqueues a `sync` job for each enabled account. |
| `mantle.email.sync` | per-enqueue, `singletonKey: sync:<accountId>` | Per-account incremental sync. `singletonKey` collapses duplicate enqueues. |
| `mantle.email.backfill` | per-enqueue | 90-day per-sender backfill when a sender flips to `allowed`. |

`singletonKey` collapses *enqueues* — two scheduler ticks for the same account
become one queued job. It does **not** serialize *execution* across pg-boss
retries: an in-flight job that crashes and gets retried can overlap with a
fresh scheduler-enqueued sync. The dedup model (§4) tolerates this by design.

---

## 3. The flow per account

```
scheduler tick (every 2 min)
       │
       ▼
sync queue (singletonKey: sync:<accountId>)
       │
       ▼
syncAccount(account, provider)            packages/email/src/sync.ts:36
       │
       ▼  for each folder in (included − excluded):
listSince(account, cursor)                packages/email/src/providers/imap.ts
       │  IMAP FETCH (envelope + flags + bodyStructure + Gmail labels)
       ▼
upsertSenders → resolve decision (allowed/denied/pending)
       │       packages/email/src/decisions.ts
       │
       ▼  for each `allowed` message:
ingestOne(account, provider, message, rules)
       │
       ├─ dedup pre-check (§4)
       ├─ runRules → tags + branch path
       ├─ provider.fetchFull(providerMsgId)   // bodies + attachment bytes
       └─ db.transaction { insert node + email + attachments }
              │
              └─▶ pg_notify('node_ingested', node.id)
                      │
                      ▼
              extractor (apps/agent/src/extractor.ts) — summary + embedding + facts
```

`ensureBranchPath` (also in `sync.ts`) lazily creates the `inbox.<slug>.…`
branch nodes a message lands under, idempotent on
`nodes_branch_owner_path_uq`.

---

## 4. Dedup — two-tier

The hard, non-negotiable property: **at most one `emails` row per
(account, logical-message)**. Achieved with two unique constraints + a
pre-check SELECT + race-safe INSERT.

### 4a. Two unique constraints, each catching different cases

| Index | Key | Catches |
|---|---|---|
| `emails_account_msg_uq` | `(account_id, provider_msg_id)` | Same UID in same IMAP folder. Crash-retry / restart-replay of an in-flight job seeing the same UID twice. |
| `emails_account_rfc_msg_id_uq` (partial, `WHERE rfc_message_id IS NOT NULL`) | `(account_id, rfc_message_id)` | **Cross-folder duplication.** The same logical email appearing in INBOX *and* INBOX.Archive, or any Gmail folder *and* `[Gmail]/All Mail`. |

`provider_msg_id` is **folder-scoped** — IMAP encodes it as
`<folder>:<uidvalidity>:<uid>` ([imap.ts:28](../packages/email/src/providers/imap.ts:28)),
so the same logical message in two folders looks like two different ids to
the folder-scoped key. `rfc_message_id` is the RFC 5322 Message-ID header
(envelope.messageId), assigned once by the sender's MTA and stable across
every folder/account that received the message — that's the cross-folder key.

Nullable + **partial** index on the RFC key: historical rows (pre-migration
0045) and weird mail with no Message-ID header coexist freely; the
uniqueness only fires when populated.

### 4b. The race-safe ingest pattern (`ingestOne`)

[`packages/email/src/sync.ts:144`](../packages/email/src/sync.ts:144).
Three layers, in order of cost:

```
1. SELECT pre-check (cheap)
     WHERE account_id=X
       AND (provider_msg_id=Y OR rfc_message_id=Z)   // Z only when populated
   Hit → return false. Avoids spending OpenRouter rule eval + IMAP fetchFull
   on the common case where we've already seen this message.

2. provider.fetchFull(providerMsgId)
   Heavy: IMAP round-trip for body + attachments. Opens a race window
   between step 1 and step 3.

3. INSERT inside db.transaction with .onConflictDoNothing()   // untargeted!
   Untargeted = DO NOTHING on ANY unique violation, catching either dedup
   key. If the INSERT returns 0 rows (someone else inserted the same
   message while we fetched), throw DuplicateRaceError. Caught at the
   transaction boundary; the transaction rolls back cleanly (no orphan
   node, no orphan attachments) and ingestOne returns false. The pg-boss
   job succeeds — same observable outcome as the pre-check hitting.
```

**This is what closes the `[worker] [sync] error … PostgresError: duplicate
key value violates unique constraint "emails_account_msg_uq"` log noise**
that previously surfaced after dev-server restarts under Gmail All Mail UID
churn. Data integrity was always correct (transaction rollback caught the
constraint violation) — the missing piece was *not failing the pg-boss job
on a race*.

---

## 5. Labels — IMAP flags + Gmail X-GM-LABELS

`emails.labels: text[]` carries both, merged in
[`imap.ts normalizeHeader`](../packages/email/src/providers/imap.ts):

- **IMAP system flags** (`msg.flags`) — `\Seen`, `\Answered`, `\Flagged`.
- **Gmail labels** (`msg.labels`, only when the server returns
  `X-GM-EXT-1` capability) — `\Inbox`, `\Sent`, `\Important`, `\Starred`,
  `\Trash`, `\Draft`, `\Spam`, plus any custom labels the user created
  ("Family", "Work", `Family/Schoeman`).

The fetch call passes `labels: true` unconditionally — ImapFlow ignores it
on non-Gmail servers, so it's safe everywhere.

Net effect: for Gmail you can distinguish *currently in inbox* vs
*archived* vs *labeled-X* by inspecting `emails.labels` directly, even if
all the rows live in a single folder. This is the enabling step for the
"All Mail only" config (one folder in `imap_included_folders`, zero
folder-duplication, full coverage including archived mail).

---

## 6. Gmail's `[Gmail]/All Mail` quirk

Worth knowing because it's the #1 source of "ingestion is happening even
though I didn't send/receive anything new":

- **All Mail is a virtual folder** containing every Gmail message —
  Inbox, Sent, Archive, custom labels, everything.
- Gmail assigns **new UIDs in All Mail whenever a message is labeled,
  moved, archived, or reclassified** — not just on receipt.
- Each new UID looks like a brand-new message to the folder-scoped
  `provider_msg_id`, so the sync pulls them all.
- After §4's RFC dedup, the row count stays correct — the second arrival
  (same `rfc_message_id`) collides on the partial unique index, INSERT
  returns 0, race path swallows it, no logged stack, no failed job.

Practically: an overnight gap in syncing → 100+ "ingested" UIDs at
restart, but with `rfc_message_id` populated they collapse onto existing
rows. Expect the trace count to spike, the row count not to.

---

## 7. Per-account config — what controls what

On `email_accounts`:

| Column | Effect |
|---|---|
| `enabled` | Master switch. `false` → scheduler still ticks, sync worker skips. |
| `ingest_policy` | `approve_list` (IMAP default — only `allowed` senders ingest) or `block_list` (anything not `denied`). |
| `first_scan_days` | On first connect / `uidvalidity` reset, look back this many days. Default in `imap.ts` constants. |
| `imap_included_folders` | Per-account allow-list. Intersected with the server's live folder list. Empty / null → "everything that isn't excluded". |
| `imap_excluded_folders` | Always-skip list (Trash, Spam, Drafts by default). |
| `branch_path` | Where this account's mail roots under `inbox.…`. Rules may override per-message. |
| `sync_state` | jsonb cursor — per-folder `{ lastUid, uidvalidity }`. Touched on every successful batch. |
| `last_sync_at` / `last_sync_error` | Telemetry — surfaced in `/settings/accounts`. |

---

## 8. Handoff to the extractor

Identical to the file / note path:

1. `db.transaction` commits `nodes` (type `email`) + `emails` + `email_attachments`.
2. AFTER INSERT trigger from migration 0018 fires `pg_notify('node_ingested', node.id)`.
3. The agent's `node_ingested` listener enqueues the node on the durable
   `mantle.extract` pg-boss queue (`apps/agent/src/extract-queue.ts`); a
   concurrency-capped worker then runs `extractNode` — the standard cascade:
   read body (joins `emails` table for subject + `body_text` — `bodyHtml` is
   ignored) → LLM summary + entities + embedding → fact extraction → entity
   reconciliation. A burst (e.g. a Gmail sync) drains at the capped rate with
   retry/backoff instead of firing every extraction at once.
4. Attachments are real `file` nodes under
   `inbox.<account>.attachments`, linked back via
   `email_attachments.file_node_id`. They extract through the same path as
   any file (PDF via pdf-parse, scanned PDFs via the OCR fallback — see
   [`file-ingestion.md`](./file-ingestion.md)).

The dispositions an `extractor_run` skip can record on email nodes:
`already_extracted` (summary + embedding already present),
`body_too_short` (< 20 chars — rare for real mail, common for
auto-generated "you have a new login" stubs).

Emails get an `extractor_run` trace but **no `content_ingest` trace** —
the IMAP path doesn't call `recordIngest`. Node-biography (`/nodes/<id>/history`)
shows the `extractor_run` only. See
[`data-flow-tracing.md §7`](./data-flow-tracing.md).

---

## 9. Delivery-kind classification (`direct` / `list` / `automated` / `marketing`)

Every ingested message gets a `delivery_kind` ∈ {`direct`,`list`,`automated`,
`marketing`,`unknown`} at sync time, computed from headers + envelope + Gmail
labels. Per-sender rollup counters on `email_senders` drive a soft hint pill on
the `/settings/senders` page so the operator can spot newsletters at a glance
and bulk-deny the lot in one click. **Header-only, no body required** — the
classification runs on the same cheap `listSince` FETCH that powers sender
curation for pending senders, so a sender still in pending gets pills as soon
as they've sent ≥3 messages. The §1 invariant ("never ingest mail you didn't
ask for") is preserved exactly: bodies still gate on `allowed`.

### 9a. The cascade — first-match-wins

Source: [`packages/email/src/classify.ts`](../packages/email/src/classify.ts).
Pure function, ~80 LOC, 32 vitest cases.

```
classifyDelivery(headers, fromAddr, labels) → DeliveryKind

  Gmail label hard-positive
    labels includes 'CATEGORY_PROMOTIONS'                              → marketing

  1. marketing  (highest-confidence "you didn't write this" signals)
    'List-Unsubscribe-Post' matches /one-click/i  AND  !Auto-Submitted → marketing
    'Precedence' === 'bulk'                                            → marketing
    'Feedback-ID' present                                              → marketing
    matches ESP fingerprint  AND  'List-Unsubscribe' present  AND
       !Auto-Submitted                                                 → marketing

  2. list  (mailing-list mail — distinct from marketing, often wanted)
    'List-ID' present                                                  → list
    'Precedence' === 'list'                                            → list

  3. automated  (machine-origin, often transactional)
    'Auto-Submitted' present and !== 'no'                              → automated
    'Precedence' === 'auto_reply'                                      → automated
    localPart matches /^(noreply|no-reply|donotreply|do-not-reply|
                          bounces?|mailer-daemon|postmaster|
                          notifications?)([-_.+]|$)/i                  → automated
    'List-Unsubscribe' present  (residual — receipts, password resets) → automated

  4. direct  (a human writing to you, probably)
    none of the above                                                  → direct
```

Key design notes:

- **`Auto-Submitted` is the marketing→automated downgrader.** Symmetric
  across both the one-click and ESP-fingerprint rules: "machine origin, no
  human" overrides "subscribed bulk." Catches the rare-but-real case of an
  ESP attaching one-click to all sends from a sender domain, including
  transactional templates.
- **Mailing lists ≠ marketing.** Church group, dev list, family Google
  Group all carry `List-ID`. Tagging `list` (not `marketing`) is what stops
  the bulk-deny affordance from sweeping them up.
- **ESP fingerprints are name-only.** Presence of any of `X-MC-User`,
  `X-Mailchimp-Campaign-ID`, `X-SG-EID`, `X-Mailgun-Sid`, `X-SES-Outgoing`,
  `X-PM-Message-Id`, `X-HS-Marketing-Email`, `X-HubSpot-Campaign-Id`,
  `X-CK-Domain`, `X-Cmail-RecipientId`, `X-ActiveCampaign-Id`,
  `X-Klaviyo-Message-Id`, `X-Mb-Mailer`, `X-Iterable-Campaign-Id`,
  `X-CIO-Delivery-ID`. One constant in `classify.ts` — adding a provider is
  a one-line edit.
- **Gmail `\Important` is not used.** Considered as a low-priority tiebreak
  but it would only fire when no other rule did — which is the path that
  already returns `direct`. Omitted to keep the cascade honest.

### 9b. Wire — headers ride the same FETCH as the envelope

`packages/email/src/providers/imap.ts` extends the cheap-path FETCH
(`listSince` *and* `listFromSender`) with `headers: CLASSIFY_HEADERS`. ImapFlow
compiles this to `BODY.PEEK[HEADER.FIELDS (...)]` inside the same FETCH command
as the envelope: one round trip, a few hundred bytes per message extra, no
body fetched. `parseHeaderBlock(buf)` folds RFC 5322 continuation lines,
handles CRLF/LF/empty, lower-cases names, keeps the first occurrence on
repeat — 7 vitest cases in `imap.test.ts`. `normalizeHeader` then calls
`classifyDelivery({headers, fromAddr, labels})` and stamps the kind onto
`RawMessage.deliveryKind`.

`listFromSender` is the approve-sender backfill path, so a sender flipping
from pending to allowed picks up classifications on its historical mail as
the backfill runs — no separate replay step needed.

### 9c. Persistence + per-sender rollup

Migration `0046_email_delivery_kind.sql`:

```sql
create type delivery_kind as enum
  ('direct', 'list', 'automated', 'marketing', 'unknown');

alter table emails
  add column delivery_kind delivery_kind not null default 'unknown';
create index emails_delivery_kind_idx on emails(delivery_kind);

alter table email_senders
  add column direct_count    integer not null default 0,
  add column list_count      integer not null default 0,
  add column automated_count integer not null default 0,
  add column marketing_count integer not null default 0;
```

`unknown` is a back-compat sentinel — the classifier itself never emits it;
historical rows ingested pre-0046 sit at `unknown` until they're re-classified
(forward-fill from the live cursor, or a one-shot script — see §9e).

`ingestOne` persists `message.deliveryKind ?? 'unknown'` onto `emails`.
`upsertSenders` (`packages/email/src/decisions.ts`) accumulates per-kind
counts per address inside one batch and bumps the four counters via the same
`onConflictDoUpdate` row that already bumps `messageCount` — still one round
trip per flush, no extra writes. Sum of the four counters equals
`messageCount` minus any `unknown`-kind backfill leftovers; `direct + list +
automated + marketing ≤ messageCount` is the invariant.

### 9d. UI surface — `/settings/senders`

Source: [`apps/web/app/(app)/settings/senders/dominant-kind.ts`](../apps/web/app/(app)/settings/senders/dominant-kind.ts)
plus the four components in that folder.

Per-row pill stamps when **≥ 3 messages** AND **≥ 70%** agree on one kind:

- `📣 marketing` (accent pill — the actionable one) · `📋 list` · `🤖 automated`
- `direct` deliberately renders nothing — it's the default, and a pill on
  every human sender would be visual noise.
- The pill is a `<Link>` to `?kind=…` — tapping narrows the current view.

Filter chip row (above the list, below the tabs): `All · Direct · Marketing ·
Lists · Automated`, URL-driven via `?kind=`. Composes with `?tab=`, `?q=`,
`?page=`. The server WHERE uses `dominantKindWhere(kind)` — an integer-only
SQL fragment (`kind * 1000 >= total * 700` for 0.7) that avoids
postgres-js's parameter-type inference trap on fractional literals against
integer columns. Symmetric at the boundary with the JS `dominantKind()`.

Bulk-deny affordance: on the pending tab only, and only when `?kind=` is
unset *or* equal to `marketing`, a button "**Deny N marketing senders**"
appears in the header when N ≥ 1. Behind an `<AlertDialog>` per the
apps/web/CLAUDE.md destructive-action rule. The action runs a single UPDATE
with the same dominance WHERE as the count — labelled number matches what
gets denied.

Knobs in one place at the top of `dominant-kind.ts`:
`MIN_MESSAGES_FOR_PILL = 3`, `DOMINANCE_THRESHOLD = 0.7`.

### 9e. Backfill — passive, or one-shot

**Passive (default).** Forward-fill from the live cursor. Every new sync
classifies fresh messages and bumps the counters. Existing pending senders
get pills as new mail arrives.

**One-shot** (`pnpm -C apps/web classify:backfill`, **SHIPPED June 2026**). For an
account-by-account replay that classifies legacy `unknown` mail without
re-ingesting bodies: `reclassifyByRefs` (`packages/email/src/providers/imap.ts`)
decodes each email's `providerMsgId` → folder+uid, re-fetches `CLASSIFY_HEADERS`
via `BODY.PEEK` (one round trip per folder, never marks read), re-runs the SAME
`classifyDelivery`, writes the true `delivery_kind`, and re-derives `nodes.salience`.
Read-only against the mailbox, dry-run by default, idempotent (only touches
`unknown`). Real run: 1,162/1,227 legacy emails reclassified.

### 9f. Retrieval salience — `delivery_kind` down-weights bulk at query time

`delivery_kind` isn't just a UI pill — since June 2026 it drives `nodes.salience`
(`marketing→0.25, list→0.5, automated→0.75, direct/unknown→1.0`,
`salienceForDeliveryKind`), set at ingest and blended into retrieval ranking so a
newsletter can't crowd out a real note. A down-weight, never a filter (explicit
`search` still finds it). For legacy `unknown` mail that `classify:backfill` can't
reach (moved/deleted), `pnpm -C apps/web backfill:email-salience` is a conservative
body-tell fallback (tracking-links + unsubscribe, with a transactional veto). Full
detail: [`memory.md` §7a](./memory.md#7a-salience--down-weighting-bulk-content) +
[`recall-eval.md`](./recall-eval.md).

---

## 10. Known sharp edges

| # | Severity | Finding | Status |
|---|---|---|---|
| E1 | 🟠 | Sync raised `23505` on (account_id, provider_msg_id) races (pg-boss retries past `singletonKey`), failing the whole pg-boss batch | ✅ **Fixed `f1486b0`** — `onConflictDoNothing` + `DuplicateRaceError` sentinel + transaction rollback. Job succeeds; data unchanged. |
| E2 | 🟠 | Cross-folder duplication — same message in INBOX + Archive + All Mail = 2-3 rows. ~80% of Gmail mail lives in `[Gmail]/All Mail` only (archive removes the Inbox label), so the dup pattern was structural | ✅ **Fixed `6a142bb` / migration 0045** — `rfc_message_id` cross-folder dedup. Forward-only: existing dup rows stay (folder/label history is meaningful), new ingests collapse. |
| E3 | 🟡 | Gmail labels (`\Inbox`, custom labels) weren't being parsed — `emails.labels` only had IMAP flags | ✅ **Fixed `6a142bb`** — fetch passes `labels: true`; `normalizeHeader` merges `msg.labels` into `emails.labels`. |
| E4 | 🟡 | No backfill of `rfc_message_id` on pre-0045 rows | ⚠️ **Deferred** — would require re-fetching IMAP headers for every legacy row. Acceptable because partial unique index lets NULL rows coexist; cross-folder dedup applies to new ingests only. Legacy 152 dup rows persist as queryable history. |
| E5 | 🟡 | `pg-boss` retry path doesn't re-honour scheduler's `singletonKey` — a stuck job can overlap a fresh enqueue. Now harmless (race-safe), but the retry timing is governed by pg-boss internals, not by us | Accepted — design tolerates it via §4's race handling. |
| E6 | 🟡 | Gmail's All Mail UID churn → high "ingested" trace counts on a sync after an idle gap, even though row count stays correct | Accepted — visible in `/debug` but no real waste (extractor `already_extracted`-skips on each race-rejected dup). Excluding `[Gmail]/All Mail` from `imap_included_folders` *now that X-GM-LABELS populates* is the operational move when the operator's ready. |
| E7 | 🟡 | `bodyHtml` is stored but the extractor ignores it (uses `body_text` only). HTML-only mail with no text alternative gets a thin body | Accepted — most real mail has a text/plain part; rare edge. |
| E8 | 🟡 | No web UI for sender curation beyond the basic `/settings/senders` list | Partial — pagination + broader search (`address \| domain \| display_name`) shipped; bulk-deny-marketing button on the pending tab shipped (§9d). Bulk-approve and per-sender history view still open. |
| E9 | 🟡 | Historical `emails` rows (ingested before migration 0046) sit at `delivery_kind = 'unknown'` until re-classified. Their senders' four `*_count` columns can be flat 0s with a non-zero `messageCount` — pill won't appear despite the sender being a clear newsletter | ✅ **Fixed June 2026** — `pnpm -C apps/web classify:backfill` (`reclassifyByRefs`, §9e) re-fetches headers over IMAP and reclassifies legacy `unknown` mail + re-derives salience. Ran 1,162/1,227. Per env; the ~65 it can't reach (moved/deleted) fall to the `backfill:email-salience` body fallback. |

---

## 11. Operational verification

Read-only patterns that help debug a sync:

```sql
-- Account health
select address, enabled, ingest_policy,
       to_char(last_sync_at,'YYYY-MM-DD HH24:MI') as last_sync,
       coalesce(last_sync_error,'-') as last_err,
       sync_state->'imap'->'folders' as cursors
from email_accounts;

-- Volume by REAL email date (not ingest time)
select to_char(date_trunc('day',internal_date),'YYYY-MM-DD') day, count(*)
from emails where internal_date > now() - interval '14 days'
group by 1 order by 1 desc;

-- rfc_message_id coverage on recent ingests — should be 100% post-0045
select count(*) total,
       count(*) filter (where rfc_message_id is not null) with_rfc
from emails e join nodes n on n.id=e.node_id
where n.created_at > now() - interval '30 minutes';

-- Any new cross-folder dups slipping through (should be empty)
select rfc_message_id, count(*), array_agg(folder)
from emails where rfc_message_id is not null
  and created_at > now() - interval '24 hours'
group by 1 having count(*) > 1;

-- Re-fire the extractor on one email (e.g. after a code fix)
select pg_notify('node_ingested', '<node-id>');

-- Delivery-kind distribution across recent ingests (§9)
select delivery_kind, count(*)
from emails where internal_date > now() - interval '30 days'
group by 1 order by 2 desc;

-- Senders the pill is about to light up (≥3 msgs, ≥70% marketing)
select address, message_count, marketing_count,
       round(100.0 * marketing_count / message_count) as pct
from email_senders
where status = 'pending'
  and message_count >= 3
  and marketing_count * 1000 >= message_count * 700  -- 0.7 as integer math
order by message_count desc limit 20;
```

Tail the worker's stdout for `[sync] <maskedEmail> done in Xms — scanned=N
ingested=M newSenders=K` lines. A healthy sync logs one of these per
account per tick; failed jobs log `[sync] error on <maskedEmail>` + a
stack — and post-`f1486b0` should be rare.

---

## 12. Source-of-truth files

If you only read three files in the email-ingest layer, read in this order:

1. [`packages/email/src/sync.ts`](../packages/email/src/sync.ts) — `syncAccount` + `ingestOne` (the dedup + race-handling pattern).
2. [`packages/email/src/providers/imap.ts`](../packages/email/src/providers/imap.ts) — IMAP fetch options, `normalizeHeader`, the providerMsgId encoding, `parseHeaderBlock`.
3. [`apps/web/workers/email-sync.ts`](../apps/web/workers/email-sync.ts) — the pg-boss queue wiring (scheduler + sync + backfill).

And for §9 specifically: [`packages/email/src/classify.ts`](../packages/email/src/classify.ts) (the rule cascade) and
[`apps/web/app/(app)/settings/senders/dominant-kind.ts`](../apps/web/app/(app)/settings/senders/dominant-kind.ts) (the pill threshold + the integer-only SQL helper).

Migration trail: `0001` (initial), `0033` (per-account included folders),
`0041` (SMTP submission), `0045` (rfc_message_id + partial unique index),
`0046` (delivery_kind + per-sender rollup counters).

---

## 13. Changelog (this arc)

Newest first — all on `main`.

| Commit | What |
|---|---|
| `059bc86` | Integer-only SQL in `dominantKindWhere` — sidesteps postgres-js fractional-parameter type inference against integer columns |
| `8c6b3f6` | Audit follow-ups: one-click + Auto-Submitted → automated (symmetric guard); bulk-deny visibility gated on `kind=null \| marketing` |
| `e692dc3` | Senders UI: per-row pill, `?kind=` filter chip, conditional "Deny N marketing" with AlertDialog (§9d) |
| `3be9c53` | Schema + wire: migration 0046, `headers: [...]` on the cheap-path FETCH, `parseHeaderBlock`, classify in `normalizeHeader`, persist on `emails`, bump per-kind counters in `upsertSenders` |
| `7cb4974` | Pure classifier `direct \| list \| automated \| marketing` + 31 vitest cases (zero runtime effect on its own) |
| `20ba103` | Senders pagination (50/page, URL-driven) + broader search (address \| domain \| display_name) |
| `6a142bb` | Cross-folder dedup via RFC Message-ID (migration 0045) + Gmail X-GM-LABELS into `emails.labels` |
| `f1486b0` | Race-fix: `onConflictDoNothing` + `DuplicateRaceError` sentinel — no more 23505 stacks failing pg-boss jobs |
| `b9432d7` | Per-recipient allowlist gate on `email_send` / `email_page` |
| `8988b4d` | `email_list` / `email_get` builtins so Saskia can read mail (was send-only) |
| `9c93509` | `email_send` tool — Saskia sends via provider SMTP |
| `8e93154` | Configurable per-account `first_scan_days` |
| `8ac0366` | Per-account IMAP folder include-list |
