# Mail in (the Sync service)

Mail comes in through the Sync service (`server/sync`, Sync plan M2,
[services.md](./services.md) "Sync"). The sidecar reads the mailbox; the
brain decides what it keeps and stores it. Before M4 the brain's own worker
did both; that design is in [\_archive/email-ingest.md](./_archive/email-ingest.md).

## The one rule: contacts are the gate

Mail is kept only when its sender is a contact (an exact address, or an
`@domain` wildcard on a contact) or one of the owner's own mailbox
addresses. Mail from anyone else is never fetched: no row, no file, no
trace. The gate is `loadContactGate` (`@mantle/content`), in the brain.

## A run of a mailbox

Every 5 minutes, one mailbox at a time:

1. The sidecar logs in over IMAP (the server's address checked first: a
   link-local, metadata or reserved address is refused; a LAN address is
   allowed) and lists each scanned folder's new UIDs: those past the
   cursor, or, on a first scan or a uidvalidity change, the messages of the
   last `firstScanDays` (365 by default).
2. It reads their envelopes in batches of 50 and asks the brain which to
   fetch: `POST /api/sidecar/mail/gate` (`gateEnvelopes`,
   `packages/email/src/ingest.ts`). The brain answers the ones whose sender
   passes the gate, that are no client sign-in code mail, and that the
   mailbox does not hold yet (the same folder UID, or the same RFC
   Message-ID in any folder).
3. It fetches those in full on the same connection, parses them, and posts
   each: `POST /api/sidecar/mail/ingest` (`ingestWireMessage`). The brain
   judges the gate again, runs the ingest rules, and writes the email node,
   the `emails` row and each attachment as a file node (content-addressed).
   A sign-in link's code is blanked in everything stored. Both dedup keys
   are unique indexes, so a race stores a message once.
4. It moves the cursor after each batch (`cursor:<mailbox>` in
   `service_state`) and reports the run: `POST /api/sidecar/mail/run`
   (a `sync_runs` row, the mailbox's last sync stamp or error).

What crosses is the old adapter's parsed shape
(`packages/email/src/wire.ts`), attachments in base64; the ingest route's
body ceiling is 64 MB. A message over 40 MB (or one whose server names no
size) is read as a stream instead (`server/sync/src/mail-stream.ts`): each
attachment streams on to `POST /api/sidecar/mail/attachment` as it is
parsed (spooled to disk there, stored in the object store under its
sha256, up to the streamed upload cap), and the message posts naming them
(`staged`). A body over 16 MB goes as a `message-body` attachment of its
own; a message over 40 MB whose body text alone is over 16 MB is read part
by part (IMAP), each large text part staged the same way. What could not be
taken in (an attachment over the cap, attachments past the 500 a message
holds) is named in a note at the top of the body: nothing is dropped
silently. A message the mail server (or Microsoft) fails on never holds a
mailbox: the run goes on past it and keeps it to try again (`msgfail:`,
at most 500 a mailbox; past that the run stops rather than let one go).
Each run tries those again first; one that reads is stored whole. Only
after three tries over a day is it stored with what could be read and a
note saying what could not, so an outage never turns mail into stubs. The
brain's own failures, a token, a throttle or the network stop the run, and
the cursor stays.

## A new contact

A new contact address (made in the app, by `contact_create` or
`contact_update`, or from Discover) asks the sidecar for a backfill
(`enqueueBackfills`, `POST /backfill`): that sender's mail in every mailbox,
back to the mailbox's first-scan reach (`firstScanDays`, 365 days unless
set), through the same gate and store. The backfill is a job kept in
`service_state` (`backfill:<id>`) until it reaches the end: each run reads
a share of each mailbox (2 500 envelopes, or 50 Outlook pages) and keeps
its place per folder (one job per new address, its marks pruned as they
finish, so a job stays small), and the scheduler goes on with it every 5 minutes,
after a failure or a restart too. With Sync off nothing is asked.

## Discover

Settings > Sync > "Find senders" scans the last 30 days of every mailbox
(headers only, at most 800 messages each) and lists the senders who are no
contact yet. "Add as contact" makes the contact, which starts its backfill.

## Mailbox rows

Each linked mailbox has one `email_accounts` row: the owner link of its
stored mail, its address, name, branch path (`inbox.<local>_<hash>`) and
switch. Its settings and app password are the sidecar's, sealed in
`service_state`. Removing a mailbox switches its row off and deletes its
settings; its stored mail stays, readable and searchable.
