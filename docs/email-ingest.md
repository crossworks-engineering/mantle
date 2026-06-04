# Email ingestion

How email enters Mantle, gets gated against your contacts, deduplicated, and
reaches the brain. This is the canonical reference for the inbound subsystem;
companion to [`email-send.md`](./email-send.md) (outbound via SMTP submission),
[`contacts.md`](./contacts.md) (the contact model + UI), and
[`architecture.md §8`](./architecture.md#8-email-pipeline) (the one-paragraph view).

> **The big idea:** *never ingest mail you didn't ask for.* The **contacts list
> is the gate** — the same list that authorises outbound send, now applied to
> inbound too. A message is ingested only if its `From` matches a contact (an
> exact address **or** a `@domain` wildcard) or one of your own account
> addresses. Everything else is silently rejected: never fetched, never stored.
> Once a message passes the gate it lands as a `nodes` row of type `email`
> exactly like a note or a file, the `node_ingested` trigger fires, and the
> extractor indexes it. Mail is just another node type from that point on.

> **2026-06-04 — sender curation retired.** Mantle used to gate inbound on a
> per-sender `pending`/`approved`/`denied` curation layer (`email_senders` /
> `email_sender_domains`, `/settings/senders`, `SenderResolver`). That whole
> machinery is **gone**, replaced by the contacts gate described here. If you're
> reading older notes that mention "approve a sender", read this instead. See
> §12 for the migration.

---

## 1. The model

Three persistent shapes for mail, plus the gate:

| Table / node | Purpose |
|---|---|
| `email_accounts` | One row per mailbox. IMAP host/port/secure + SMTP knobs + `imap_config_enc` (AES-GCM-sealed app password) + per-account include/exclude folder lists + `sync_state` jsonb (per-folder cursor) + `last_sync_at` / `last_sync_error`. |
| `emails` | One row per ingested message. Companion to a `nodes` row of type `email`. Two unique keys (see §4). |
| `email_attachments` | One row per attachment, deduped by sha256 across the brain via file-node sharing. |
| **`nodes` of type `contact`** | **The gate.** Each contact's `data.emails: string[]` lists the addresses + `@domain` wildcards whose mail Mantle will ingest. Same list gates outbound send (concrete addresses only — see §6). UI at `/contacts`; full model in [`contacts.md`](./contacts.md). |

There is no longer an `email_senders` table. The gate is computed live from the
contacts list on each sync (§2).

---

## 2. The worker — pg-boss queues + scheduler

`apps/web/workers/email-sync.ts` is a separate Node process during `pnpm dev`.
Three queues, all in the `pgboss` Postgres schema (jobs survive restarts):

| Queue | Cadence | What it does |
|---|---|---|
| `mantle.email.scheduler` | **every 2 min** (`*/2 * * * *`) | Fan-out: enqueues a `sync` job for each enabled account. |
| `mantle.email.sync` | per-enqueue, `singletonKey: sync:<accountId>` | Per-account incremental sync. `singletonKey` collapses duplicate enqueues. |
| `mantle.email.backfill` | per-enqueue | 90-day backfill of one contact entry (an address **or** a `@domain`) when a contact email/domain is added. |

`singletonKey` collapses *enqueues* — two scheduler ticks for the same account
become one queued job. It does **not** serialize *execution* across pg-boss
retries: an in-flight job that crashes and gets retried can overlap with a
fresh scheduler-enqueued sync. The dedup model (§4) tolerates this by design.

The backfill queue is published by the shared `enqueueBackfill` /
`enqueueBackfills` helper in
[`packages/email/src/backfill-queue.ts`](../packages/email/src/backfill-queue.ts)
(`BACKFILL_QUEUE` is exported there and imported by the worker, so the queue
name has one source of truth). Every caller that adds a contact entry — the web
contacts API, the `contact_*` agent builtins, and the discover-senders page —
goes through it. Best-effort: a queue hiccup never fails the contact write.

---

## 3. The flow per account

```
scheduler tick (every 2 min)
       │
       ▼
sync queue (singletonKey: sync:<accountId>)
       │
       ▼
syncAccount(account, provider)            packages/email/src/sync.ts
       │
       ├─ gate = loadContactGate(userId)   @mantle/content — exact ∪ @domain ∪ own accounts
       │
       ▼  for each folder in (included − excluded):
listSince(account, cursor)                packages/email/src/providers/imap.ts
       │  IMAP FETCH (envelope + flags + bodyStructure + Gmail labels + classify headers)
       ▼
for each message:
   gate.allows(fromAddr)?  ── no ──▶ skip (no fetch, no row, no disk)
       │ yes
       ▼
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

The gate is loaded **once per sync run**. A contact added mid-run takes effect
on the next tick — but the **backfill-on-add** (§7) pulls that
sender's/domain's recent history immediately, so there's no waiting for the
forward cursor to catch up.

### 3a. The gate — `loadContactGate`

[`packages/content/src/contact-gate.ts`](../packages/content/src/contact-gate.ts).
Loads, per owner: every contact's `data.emails` split into an exact-address set
and a domain set (the `@`-entries, stored bare), plus the owner's own
`email_accounts.address` set. Then:

```
allows(fromAddr) = exact.has(addr)            // jason@schoeman.me
               || ownAccounts.has(addr)        // your own sent/self mail
               || domains.has(domainOf(addr))  // @schoeman.me wildcard
```

- **`@domain` wildcards** mean "trust all mail from this domain" — the whole-org
  case (a church group, a company you deal with). Stored as `@schoeman.me`;
  matched against the From address's domain.
- **Own-account addresses are always allowed.** Mail *from* you (Sent items,
  notes-to-self) ingests even with zero contacts — it's yours.
- **Empty contacts ⇒ nothing inbound is ingested** (own mail aside). This is
  intentional, and is *not* a regression: the old `approve_list` with zero
  approved senders also ingested nothing. An empty allowlist is an empty inbox,
  not a firehose. `gate.isEmpty` drives the `/inbox` "add a contact" nudge.

The address/domain split is a pure helper, `partitionEmailEntries`, in
[`contacts-format.ts`](../packages/content/src/contacts-format.ts) (browser-safe,
unit-tested). The same function feeds the outbound send allowlist — see §6 for
the deliberate asymmetry.

---

## 4. Dedup — two-tier

Unchanged by the gate rework. The hard, non-negotiable property: **at most one
`emails` row per (account, logical-message)**. Achieved with two unique
constraints + a pre-check SELECT + race-safe INSERT.

### 4a. Two unique constraints, each catching different cases

| Index | Key | Catches |
|---|---|---|
| `emails_account_msg_uq` | `(account_id, provider_msg_id)` | Same UID in same IMAP folder. Crash-retry / restart-replay of an in-flight job seeing the same UID twice. |
| `emails_account_rfc_msg_id_uq` (partial, `WHERE rfc_message_id IS NOT NULL`) | `(account_id, rfc_message_id)` | **Cross-folder duplication.** The same logical email appearing in INBOX *and* INBOX.Archive, or any Gmail folder *and* `[Gmail]/All Mail`. |

`provider_msg_id` is **folder-scoped** — IMAP encodes it as
`<folder>:<uidvalidity>:<uid>` ([imap.ts](../packages/email/src/providers/imap.ts)),
so the same logical message in two folders looks like two different ids to
the folder-scoped key. `rfc_message_id` is the RFC 5322 Message-ID header
(envelope.messageId), assigned once by the sender's MTA and stable across
every folder/account that received the message — that's the cross-folder key.

Nullable + **partial** index on the RFC key: historical rows (pre-migration
0045) and weird mail with no Message-ID header coexist freely; the
uniqueness only fires when populated.

### 4b. The race-safe ingest pattern (`ingestOne`)

[`packages/email/src/sync.ts`](../packages/email/src/sync.ts). Three layers, in
order of cost:

```
1. SELECT pre-check (cheap)
     WHERE account_id=X
       AND (provider_msg_id=Y OR rfc_message_id=Z)   // Z only when populated
   Hit → return false. Avoids spending IMAP fetchFull + rule eval on the
   common case where we've already seen this message.

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

This is what keeps the `duplicate key value violates unique constraint
"emails_account_msg_uq"` log noise from failing pg-boss jobs after dev-server
restarts under Gmail All Mail UID churn.

---

## 5. Labels — IMAP flags + Gmail X-GM-LABELS

`emails.labels: text[]` carries both, merged in
[`imap.ts normalizeHeader`](../packages/email/src/providers/imap.ts):

- **IMAP system flags** (`msg.flags`) — `\Seen`, `\Answered`, `\Flagged`.
- **Gmail labels** (`msg.labels`, only when the server returns
  `X-GM-EXT-1` capability) — `\Inbox`, `\Sent`, `\Important`, `\Starred`,
  `\Trash`, `\Draft`, `\Spam`, plus any custom labels the user created.

The fetch call passes `labels: true` unconditionally — ImapFlow ignores it
on non-Gmail servers, so it's safe everywhere. For Gmail you can distinguish
*currently in inbox* vs *archived* vs *labeled-X* by inspecting `emails.labels`
directly, even if all the rows live in a single folder.

---

## 6. Send-gate asymmetry — domains are inbound-only

The contacts list gates **both** directions, but not symmetrically:

- **Inbound (this doc):** the `ContactGate` honours both exact addresses and
  `@domain` wildcards.
- **Outbound** ([`email-send.md`](./email-send.md)): the send allowlist
  (`contactEmails`, `findContactsByEmails` in
  [`contacts.ts`](../packages/content/src/contacts.ts)) is **concrete addresses
  only**. A `@domain` wildcard does *not* let Saskia mail an arbitrary address
  at that domain — you can't "send to a whole domain".

This is deliberate: a domain wildcard expresses "trust mail *from* here", which
is a much weaker statement than "I may write to anyone here". Both sites carry a
comment flagging the asymmetry.

---

## 7. Adding a contact → 90-day backfill

When a contact email/domain is **added** (new entry, not an existing one),
Mantle enqueues a backfill so that sender's/domain's recent mail flows into the
brain immediately rather than waiting for the forward cursor.

- `createContact` / `updateContact` ([`contacts.ts`](../packages/content/src/contacts.ts))
  return `{ contact, addedEmails }`. `addedEmails` is the set of entries newly
  present (every entry on create; only the new ones on update).
- Each caller enqueues a backfill for those entries via `enqueueBackfills`
  (§2): the web contacts API
  ([`app/api/contacts`](../apps/web/app/(app)/../api/contacts/route.ts)), the
  `contact_create`/`contact_update` agent builtins
  ([`builtins-contacts.ts`](../packages/tools/src/builtins-contacts.ts)), and
  the discover page's "Add as contact" action.
- The worker runs `backfillMatch(account, provider, target)`
  ([`sync.ts`](../packages/email/src/sync.ts)). `target` is an address or a
  bare domain:
  - **address** → IMAP `search({from: address})`, keep `fromAddr === target`.
  - **domain** → IMAP `search({from: domain})` (substring match), keep
    `domainOf(fromAddr) === target` (rejects substring false-positives like
    `x.com.evil.com`).
- No gate re-check inside the backfill — the caller only enqueues for an entry
  it just added, so the target is allowed by construction.

---

## 8. Per-account config — what controls what

On `email_accounts`:

| Column | Effect |
|---|---|
| `enabled` | Master switch. `false` → scheduler still ticks, sync worker skips. |
| `first_scan_days` | On first connect / `uidvalidity` reset, look back this many days. Default 365. |
| `imap_included_folders` | Per-account allow-list of folders. Intersected with the server's live folder list. Empty / null → "everything that isn't excluded". |
| `imap_excluded_folders` | Always-skip list (Trash, Spam, Drafts by default). |
| `branch_path` | Where this account's mail roots under `inbox.…`. Rules may override per-message. |
| `sync_state` | jsonb cursor — per-folder `{ lastUid, uidvalidity }`. Touched on every successful batch. |
| `last_sync_at` / `last_sync_error` | Telemetry — surfaced in `/settings/accounts`. |
| `ingest_policy` | **Vestigial** (`@deprecated`). Was `approve_list` / `block_list`; the contacts gate now governs ingestion universally. Left in place to avoid schema churn; nothing reads it. |

Folder config controls *which mailboxes get scanned*; the contacts gate controls
*whose mail gets ingested*. They're independent — narrowing folders never
substitutes for the gate.

---

## 9. Handoff to the extractor

Identical to the file / note path:

1. `db.transaction` commits `nodes` (type `email`) + `emails` + `email_attachments`.
2. AFTER INSERT trigger from migration 0018 fires `pg_notify('node_ingested', node.id)`.
3. The agent's `node_ingested` listener enqueues the node on the durable
   `mantle.extract` pg-boss queue (`apps/agent/src/extract-queue.ts`); a
   concurrency-capped worker runs `extractNode` — read body (joins `emails` for
   subject + `body_text`; `bodyHtml` is ignored) → LLM summary + entities +
   embedding → fact extraction → entity reconciliation.
4. Attachments are real `file` nodes under `inbox.<account>.attachments`, linked
   back via `email_attachments.file_node_id`. They extract through the same path
   as any file (PDF via pdf-parse, scanned PDFs via the OCR fallback — see
   [`file-ingestion.md`](./file-ingestion.md)).

The dispositions an `extractor_run` skip can record on email nodes:
`already_extracted` (summary + embedding already present), `body_too_short`
(< 20 chars). Emails get an `extractor_run` trace but **no `content_ingest`
trace** — the IMAP path doesn't call `recordIngest`. See
[`data-flow-tracing.md §7`](./data-flow-tracing.md).

---

## 10. Delivery-kind classification + salience (`direct`/`list`/`automated`/`marketing`)

Every ingested message gets a `delivery_kind` ∈ {`direct`,`list`,`automated`,
`marketing`,`unknown`} at sync time, computed from headers + envelope + Gmail
labels — **header-only, no body required**.

This survived the sender-curation retirement because it's orthogonal to the
gate: even a *trusted contact* (or a whitelisted `@domain`) can send you
newsletters, and you don't want those crowding out real correspondence at
retrieval. What retired was the *per-sender rollup counters + the
`/settings/senders` pills/bulk-deny* — those lived on the dropped
`email_senders` table. The classifier itself, and what it drives, stays.

### 10a. The cascade — first-match-wins

Source: [`packages/email/src/classify.ts`](../packages/email/src/classify.ts).
Pure function, ~80 LOC, 32 vitest cases.

```
classifyDelivery(headers, fromAddr, labels) → DeliveryKind

  Gmail label hard-positive
    labels includes 'CATEGORY_PROMOTIONS'                              → marketing

  1. marketing
    'List-Unsubscribe-Post' matches /one-click/i  AND  !Auto-Submitted → marketing
    'Precedence' === 'bulk'                                            → marketing
    'Feedback-ID' present                                              → marketing
    matches ESP fingerprint  AND  'List-Unsubscribe' present  AND
       !Auto-Submitted                                                 → marketing

  2. list
    'List-ID' present                                                  → list
    'Precedence' === 'list'                                            → list

  3. automated
    'Auto-Submitted' present and !== 'no'                              → automated
    'Precedence' === 'auto_reply'                                      → automated
    localPart matches /^(noreply|no-reply|…|notifications?)([-_.+]|$)/i → automated
    'List-Unsubscribe' present  (residual — receipts, password resets) → automated

  4. direct                                                            → direct
```

`Auto-Submitted` is the marketing→automated downgrader ("machine origin, no
human" overrides "subscribed bulk"). Mailing lists (`List-ID`) are tagged `list`,
not `marketing`. ESP fingerprints are name-only (presence is the signal); the
list is one constant in `classify.ts`.

### 10b. Salience — down-weighting bulk at query time

`delivery_kind` drives `nodes.salience` (`salienceForDeliveryKind`:
`marketing→0.25, list→0.5, automated→0.75, direct/unknown→1.0`), set at ingest
in `insertEmailNode` and blended into retrieval ranking so a newsletter can't
crowd out a real note. A down-weight, never a filter (explicit `search` still
finds it). Keep the map in sync with the CASE in migration 0073 (the historical
backfill). Full detail: [`memory.md` §7a](./memory.md#7a-salience--down-weighting-bulk-content)
+ [`recall-eval.md`](./recall-eval.md).

### 10c. Wire — headers ride the same FETCH as the envelope

`imap.ts` extends the cheap-path FETCH (`listSince`, `listFromSender`,
`listRecent`) with `headers: CLASSIFY_HEADERS`. ImapFlow compiles this to
`BODY.PEEK[HEADER.FIELDS (...)]` inside the same FETCH command as the envelope:
one round trip, a few hundred bytes per message extra, no body fetched.
`parseHeaderBlock(buf)` folds RFC 5322 continuation lines; `normalizeHeader`
calls `classifyDelivery(...)` and stamps `RawMessage.deliveryKind`.

---

## 11. Discovering senders — `/settings/discover`

With no sender table, how do you find someone new worth adding? A **live-peek
discovery view** ([`apps/web/app/(app)/settings/discover`](../apps/web/app/(app)/settings/discover/page.tsx)):

- The server action `recentUnknownSenders()` calls `peekRecentSenders(account,
  imap, …)` ([`peek.ts`](../packages/email/src/peek.ts)) for each enabled IMAP
  account — a **bounded** recent-mail header scan
  (`provider.listRecent`, last 30 days, capped at `RECENT_SCAN_CAP = 800`
  messages, `BODY.PEEK` only). **Nothing is persisted.**
- The collected senders are filtered through `loadContactGate` → only the ones
  the gate does *not* already allow are shown (the genuinely unknown ones), with
  message count + latest subject/date.
- "Add as contact" calls `addContactFromSender` → `createContact` (writes
  `data.emails: [addr]`) → enqueues the §7 backfill. The row disappears from the
  list on success.

This is the deliberate, on-demand replacement for the old always-on pending
queue: you look when you want to, and nothing about a rejected sender is stored.

---

## 12. Migration & cutover — 0074 + the purge script

**Migration `0074_contacts_email_allowlist.sql`** (hand-written + a
`meta/_journal.json` entry — this repo does *not* use `drizzle-kit generate`):

1. Moves each contact's single `data.email` → `data.emails` array (one-element,
   lowercased; idempotent — skips rows that already have `emails`).
2. Drops `email_senders`, `email_sender_domains`, and the `sender_status` /
   `sender_domain_status` enums.
3. Drops `sync_runs.new_senders`.

The shipped code is **forward-compatible with the un-migrated schema** (the
contact `rowOf` reader falls back to the legacy `data.email`; nothing references
the dropped tables; `sync_runs` inserts omit the dropped column), so the code
can land before the migration runs. Run it per environment:
`pnpm -C packages/db migrate`.

**Cutover cleanup — `pnpm -C apps/web purge:noncontact`**
([`scripts/purge-noncontact-emails.ts`](../apps/web/scripts/purge-noncontact-emails.ts)).
Mail already ingested under the old approve-list stays in the brain until you
purge it. The script (dry-run default, mirrors `backfill:email-salience`
ergonomics):

- Loads the `ContactGate`; flags every `email` node whose `fromAddr` the gate no
  longer allows. **Refuses to run if the contacts list is empty** (everything
  would be flagged).
- Prints a count + 20-row sample. `--apply` deletes the email **node** rows (FK
  cascade removes `emails` + `email_attachments`; the 0058 trigger reaps
  `mentioned_in` edges).
- Orphan attachment file nodes (an attachment whose only email is now gone) are
  **reported by default**; `--purge-orphan-files` deletes those nodes too
  (storage bytes are content-addressed and left to normal reconciliation).
- Flags: `--account=<uuid>`, `--limit=<n>`. **Always eyeball the sample before
  `--apply`** — deletes are irreversible.

---

## 13. Known sharp edges

| # | Severity | Finding | Status |
|---|---|---|---|
| E1 | 🟠 | Sync raised `23505` on (account_id, provider_msg_id) races (pg-boss retries past `singletonKey`), failing the whole pg-boss batch | ✅ **Fixed** — `onConflictDoNothing` + `DuplicateRaceError` sentinel + transaction rollback. Job succeeds; data unchanged. |
| E2 | 🟠 | Cross-folder duplication — same message in INBOX + Archive + All Mail | ✅ **Fixed — migration 0045** — `rfc_message_id` cross-folder dedup. Forward-only. |
| E3 | 🟡 | Empty contacts ⇒ zero inbound ingestion | Accepted — intentional (an empty allowlist is an empty inbox). The `/inbox` nudge + `/settings/discover` point the user at adding contacts. Mirrors the old empty-`approve_list` behaviour. |
| E4 | 🟡 | Gmail's All Mail UID churn → high "scanned" trace counts after an idle gap, even though row count stays correct (dedup) | Accepted — visible in `/debug`, no real waste (extractor `already_extracted`-skips race-rejected dups). Excluding `[Gmail]/All Mail` from `imap_included_folders` is the operational move when ready. |
| E5 | 🟡 | `bodyHtml` is stored but the extractor uses `body_text` only | Accepted — most real mail has a text/plain part; rare edge. |
| E6 | 🟡 | `@domain` backfill uses IMAP `from:` *substring* search | Mitigated — `backfillMatch` re-checks `domainOf(fromAddr) === domain`, so substring false-positives never ingest. |
| E7 | 🟡 | `ingest_policy` enum/column is dead but still present | Accepted — `@deprecated`; left to avoid schema churn. A future migration can drop it. |
| E8 | 🟡 | Discovery scan is bounded (last 30 days, 800-message cap) | Accepted — it's an interactive peek, not an audit. A sender who last wrote >30 days ago won't appear; add them by typing the address in `/contacts`. |

---

## 14. Operational verification

Read-only patterns that help debug a sync:

```sql
-- Account health
select address, enabled,
       to_char(last_sync_at,'YYYY-MM-DD HH24:MI') as last_sync,
       coalesce(last_sync_error,'-') as last_err,
       sync_state->'imap'->'folders' as cursors
from email_accounts;

-- The inbound allowlist, as the gate sees it (addresses + @domain wildcards)
select n.title,
       jsonb_array_elements_text(coalesce(n.data->'emails','[]'::jsonb)) as entry
from nodes n
where n.type = 'contact'
order by 1;

-- Volume by REAL email date (not ingest time)
select to_char(date_trunc('day',internal_date),'YYYY-MM-DD') day, count(*)
from emails where internal_date > now() - interval '14 days'
group by 1 order by 1 desc;

-- Any new cross-folder dups slipping through (should be empty)
select rfc_message_id, count(*), array_agg(folder)
from emails where rfc_message_id is not null
  and created_at > now() - interval '24 hours'
group by 1 having count(*) > 1;

-- Re-fire the extractor on one email (e.g. after a code fix)
select pg_notify('node_ingested', '<node-id>');

-- Delivery-kind distribution across recent ingests
select delivery_kind, count(*)
from emails where internal_date > now() - interval '30 days'
group by 1 order by 2 desc;
```

Tail the worker's stdout for `[sync] <maskedEmail> done in Xms — scanned=N
ingested=M` lines (a healthy sync logs one per account per tick) and
`[backfill] <maskedEmail> ← <target>: ingested N` when a contact is added.

---

## 15. Source-of-truth files

If you only read a few files in the email-ingest layer, read in this order:

1. [`packages/email/src/sync.ts`](../packages/email/src/sync.ts) — `syncAccount` (the gate + ingest loop), `ingestOne` (dedup + race handling), `backfillMatch`.
2. [`packages/content/src/contact-gate.ts`](../packages/content/src/contact-gate.ts) — `loadContactGate`; the address/domain/own-account matching.
3. [`packages/email/src/providers/imap.ts`](../packages/email/src/providers/imap.ts) — IMAP fetch options, `normalizeHeader`, the providerMsgId encoding, `listRecent`.
4. [`apps/web/workers/email-sync.ts`](../apps/web/workers/email-sync.ts) — the pg-boss queue wiring.
5. [`packages/email/src/backfill-queue.ts`](../packages/email/src/backfill-queue.ts) — the shared backfill enqueuer.

And for classification: [`packages/email/src/classify.ts`](../packages/email/src/classify.ts).

Migration trail: `0001` (initial), `0033` (per-account included folders),
`0041` (SMTP submission), `0045` (rfc_message_id + partial unique index),
`0046` (delivery_kind), `0073` (node salience), `0074` (contacts become the sole
inbound allowlist — sender curation dropped).

---

## 16. Changelog (this arc)

Newest first — all on `main`.

| Commit | What |
|---|---|
| `12a276d` | **Contacts become the sole inbound allowlist; sender curation retired.** `data.emails[]` (address or `@domain`), `loadContactGate`, per-message gate in `syncAccount`, `backfillMatch` (address-or-domain) + shared `enqueueBackfill`, `/settings/discover` live-peek, migration 0074, `purge:noncontact` cutover script. Dropped `email_senders`/`email_sender_domains`/`/settings/senders`/`SenderResolver`. |
| `059bc86` | (pre-retirement) Integer-only SQL in the senders pill dominance filter |
| `6a142bb` | Cross-folder dedup via RFC Message-ID (migration 0045) + Gmail X-GM-LABELS |
| `f1486b0` | Race-fix: `onConflictDoNothing` + `DuplicateRaceError` sentinel |
| `8e93154` | Configurable per-account `first_scan_days` |
| `8ac0366` | Per-account IMAP folder include-list |
