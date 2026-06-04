# Contacts — the index of who Saskia may reach

A `contact` node is a person or organisation Saskia may reach — and now, the
people whose mail Mantle will ingest. It does **two** jobs at once:

1. **Identity** — fields the human form expects (name + company + emails + cell).
2. **Allowlist — both directions.** The set of contact emails IS the gate for
   *outbound* `email_send` *and* (since 2026-06-04) *inbound* ingestion. Each
   contact carries a list of entries (`data.emails`), each a full address
   (`jason@schoeman.me`) or a `@domain` wildcard (`@schoeman.me` = all mail from
   that domain). With zero contacts, *sending* is open (bootstrap) but *inbound*
   ingests nothing. Adding a contact unlocks mailing them AND lets their mail
   into the brain (with a 90-day backfill). See §2 for the deliberate
   send-vs-ingest asymmetry.

Companion docs:
- [`email-send.md`](./email-send.md) — the send half; its gate reads from here.
- [`email-ingest.md`](./email-ingest.md) — the inbound half; its `ContactGate`
  reads from here (`§3a`, `§6`).
- [`memory.md`](./memory.md) — the brain layers a contact node's `description`
  feeds into (summary / embedding / facts / entities).
- [`architecture.md` §6](./architecture.md#6-the-nodes-table--mantles-central-abstraction)
  — the `nodes` pattern this rides on (no new table).

---

## 1. The shape

A contact is a `nodes` row of `type='contact'`, fields in `data`:

```
nodes
├ type     = 'contact'
├ path     = 'contacts'                       (lazy-created branch)
├ title    = derived  (see §1a)
├ tags     = string[]                          (nodes already has tags)
└ data     = {
    first_name, last_name, company,
    emails,             // string[] — addresses and/or `@domain` wildcards
    country_code,       // "+27" — E.164-style prefix
    cell,               // digits only; pure helpers normalise/format
    description,        // "who is this for AI" — fed to the extractor
    contact_counts,     // { email: N, sms: M, … } — bumped on send success
    last_contacted_at,  // { email: ISO, sms: ISO, … }
  }
```

> **`emails` (was `email`).** Pre-2026-06-04 contacts stored a single
> `data.email` string; migration 0074 moved each into a one-element
> `data.emails` array, and the reader falls back to the legacy key for any row
> the migration missed. `ContactRow` still exposes a derived `email`
> (`= emails[0]`) so older single-email call sites keep working. Pure helpers
> for entries (`classifyEntry`, `normalizeEmailEntry`, `partitionEmailEntries`,
> `isPlausibleEmailOrDomain`) live in `contacts-format.ts`.

**No specialized table.** Fields are small/textual and fit `data` cleanly,
matching notes/todos/events. The brain auto-indexes (the `nodes` INSERT
trigger fires the extractor); future fields just add keys.

### 1a. Title precedence

`deriveContactTitle` picks the title in this order so the list/cards read well:

```
first + last  →  company  →  email  →  formatted cell  →  "Untitled contact"
```

- `Jane Smith` → **Jane Smith**.
- `Modular` (org-only) → **Modular** (no person + a company).
- `Jane @ Modular` → **Jane Smith** (person beats company; the card's
  secondary line shows the company).
- Blank draft → **Untitled contact** until you fill it.

### 1b. Cell number normalisation

Pure helpers in [`contacts-format.ts`](../packages/content/src/contacts-format.ts):

- **`normalizeCountryCode`** — accepts `+27`, `27`, `00 27`; rejects leading
  zeros (ITU-T E.164: country codes are non-zero) and codes longer than 4
  digits.
- **`digitsOnly`** — strips formatting so `(760) 810-0774` becomes `7608100774`.
- **`toE164`** — `(+27, 760810774)` → `+27760810774`. Stored on the row as
  `cellE164` (derived; not persisted) and used by the future SMS path.
- **`formatCell`** — right-to-left grouping (4 then 3s) →
  `+27 76 081 0774`. Drives the live preview in the form.

All unit-tested in [`contacts.test.ts`](../packages/content/src/contacts.test.ts).

---

## 2. The email gate — contacts ARE the allowlist (both directions)

**Outbound** — defined in [`builtins-email.ts`](../packages/tools/src/builtins-email.ts)
`blockedRecipients` / `allowlistError`, called from both `email_send` and
`email_page`:

| Contacts list | Send gate | Allowed recipients |
|---|---|---|
| **Empty** | OFF (bootstrap) | anyone |
| **Non-empty** | ON | the user's own account addresses **∪** contacts' **concrete** addresses |

Refusal returns a clear message: *"these recipients aren't in the user's
contact list: …  Ask the user to confirm and add them as contacts at /contacts."*
No tool-loop side effects, no surprise sends.

**Inbound** — defined in [`contact-gate.ts`](../packages/content/src/contact-gate.ts)
`loadContactGate(ownerId) → allows(fromAddr)`, called per message in
`syncAccount`. Mail is ingested iff `From` matches a contact address, a contact
`@domain` wildcard, or one of the user's own account addresses. Empty contacts ⇒
nothing inbound (an empty allowlist is an empty inbox). Full detail in
[`email-ingest.md` §3a](./email-ingest.md#3a-the-gate--loadcontactgate).

**The deliberate asymmetry:** domains are **inbound-only**. A `@domain` wildcard
means "trust mail *from* this domain" — it does **not** let Saskia send to an
arbitrary address there (you can't mail a whole domain). So the send gate reads
concrete addresses only (`partitionEmailEntries(...).addresses`); the inbound
gate uses both addresses and domains.

The contacts list is the **single source of truth** for both gates. A
`profiles.preferences.emailAllowlist` field (send) and the `email_senders`
curation layer (inbound) both predated this and were removed. Adding a contact
unlocks emailing them + ingesting their mail; deleting one revokes both.

---

## 3. Activity tracking — per-method counters

After every successful `email_send` / `email_page` the matching contact's
counter bumps atomically:

```sql
data.contact_counts.email     ← prev + 1
data.last_contacted_at.email  ← now()
```

Implemented by **`recordContactSent(ownerId, contactId, method)`** in
[`contacts.ts`](../packages/content/src/contacts.ts) — one chained `jsonb_set`
so concurrent sends can't lose increments. Method is open-ended on the data
side (just a key in the jsonb object); the TypeScript `ContactMethod` type
covers `'email' | 'sms'` for the call sites we wire ourselves. When the SMS
tool lands it just calls `recordContactSent(..., 'sms')`.

Surfaced in the UI: the list card shows `✉ N` when a contact has been emailed,
and the form has a small "5 emails sent · last on …" strip near the top.

---

## 4. The brain pipeline

A contact's `description` is fed to the extractor body resolver — the same
pipeline that processes notes / pages / files. The extractor reads:

```
<title>
Company: <company>            (when present and not equal to the title)
Email: <email>
Cell: <country_code> <cell>
<description>
```

…and produces:
- `nodes.data.summary` — a one-sentence summary.
- `nodes.data.entities` — names mentioned.
- `nodes.embedding` — the search vector.
- `content_chunks` rows — section-sized embeddings for long descriptions.
- `facts` rows + the ADD/UPDATE/DELETE classifier.
- `entities` reconciled (one per person/org) + `mentioned_in` edges.

So after "Don Schoeman is Jason's brother, runs Delphex Technologies…" lands
on a contact, `search_nodes("Modular")` and `entity_facts(<don's entity>)`
both find the right thing. The `contact` type is in `DEFAULT_EXTRACT_TYPES`
in [`extractor.ts`](../apps/agent/src/extractor.ts).

**Same-surname-different-given guard.** The reconciler used to collapse
`Don Schoeman` into an existing `Jason Schoeman` entity because surname
overlap alone passed the trigram + embedding thresholds. The guard
`isLikelyDifferentPerson` ([`person-names.ts`](../apps/agent/src/person-names.ts))
refuses that merge when both names look like full given-name + surname pairs
with the same surname but distinct given names. Conservative: nickname/long-
form pairs (Don/Donald), initials, and titles + initials still merge. See
[`memory.md`](./memory.md#entity-reconciliation-refinements) for the design
note.

---

## 5. Saskia's reach — the `contact_*` tools

In [`builtins-contacts.ts`](../packages/tools/src/builtins-contacts.ts):

| Tool | Purpose |
|---|---|
| `contact_find(query)` | The name→{id,email,cell} resolver. Use FIRST when the user says "email Modular". |
| `contact_list` | Browse, newest-updated first. |
| `contact_get(id)` | Full record incl. counters. |
| `contact_create(…)` | Save someone. **Only when explicitly asked.** |
| `contact_update(id, …)` | Patch — only fields you pass change. |
| `contact_delete(id)` | Removes from the email allowlist too. |

All ungated (`requiresConfirm: false`) — restraint lives in the tool
descriptions, which are loud about *"use ONLY when the user explicitly asks…
Never add contacts on your own initiative just because someone's name came up."*

**Auto-granted at boot** to responder/assistant via `CONTACT_AUTO_GRANT_SLUGS`
(part of `CORE_AUTO_GRANT_SLUGS` in `apps/agent/src/main.ts`): read + add +
update. **Delete is excluded from the auto-grant** — destructive ops require
an explicit per-agent grant in `/settings/tools`.

The motivating flow:

```
You → Saskia: "mail Modular and ask about 2020 profiles"
  ├─ contact_find("Modular")              ← { id, email, cell_e164, … }
  ├─ (gate allows: Modular is in contacts)
  ├─ email_send({ to: <email>, subject, body })
  │     ← provider relays via SMTP submission
  │     ← noteContactActivity → Modular.contact_counts.email += 1
  └─ "Sent ✅. That's the 3rd email to Modular this month."
```

---

## 6. UI — `/contacts` master-detail

- **List (left, 340px):** search + pager + accent cards. Each card shows the
  title; secondary line shows the company (if it differs from the title) or
  the email; an `✉ N` badge appears once the contact has been emailed.
- **Form (right, `max-w-2xl mx-auto`):** first / last / **company** / email /
  country-code + cell with **live formatted preview** (`+27 76 081 0774`) /
  description / tags / "5 emails sent · last on …" strip.
- **`+` button:** creates an **empty draft** (no "New contact" seed) and
  navigates to it. Drafts are inert from every gate's POV — no email ⇒ not in
  `contactEmails` ⇒ no gate engagement; no recipient match ⇒ no counter bumps.
- **Save** is a divider-topped footer floated right, labelled
  **"Save contact"** — matching the todo/event form pattern.
- **Save-time validation:** at least one of `first_name`, `last_name`, or
  `company` is required (`hasIdentity` in `contacts-format.ts`). Email and
  cell alone aren't enough — they're channels, not identities. Client
  pre-checks instantly via the leaf module; server enforces independently in
  `updateContact` as the authoritative guard.
- **Delete** is a top-right ghost button (`<Trash2 /> Delete`) with an
  `AlertDialog` confirm — matching events/notes/todos.

REST endpoints under [`apps/web/app/api/contacts/`](../apps/web/app/api/contacts/):
`GET /` list, `POST /` create, `GET /[id]`, `PATCH /[id]`, `DELETE /[id]`.
Server side imports through `@/lib/contacts` (which barrels through
`@mantle/content`); the client component imports types + pure helpers from
`@mantle/content/contacts-format` — the **leaf** subpath with no DB
transitively. Importing the barrel into a client component drags `postgres`
into the browser bundle and the build fails with `Can't resolve 'fs'`; this
split is the intentional shape.

---

## 7. Files

| Concern | File |
|---|---|
| Pure shape + format helpers (browser-safe leaf) | [`packages/content/src/contacts-format.ts`](../packages/content/src/contacts-format.ts) |
| DB CRUD + activity bumper | [`packages/content/src/contacts.ts`](../packages/content/src/contacts.ts) |
| Pure-helper tests | [`packages/content/src/contacts.test.ts`](../packages/content/src/contacts.test.ts) |
| Saskia's tools | [`packages/tools/src/builtins-contacts.ts`](../packages/tools/src/builtins-contacts.ts) |
| Send-side gate + counter bump | [`packages/tools/src/builtins-email.ts`](../packages/tools/src/builtins-email.ts) (`blockedRecipients`, `noteContactActivity`) |
| Auto-grant to responder/assistant | `CORE_AUTO_GRANT_SLUGS` in [`apps/agent/src/main.ts`](../apps/agent/src/main.ts) |
| Extractor body resolver | [`apps/agent/src/extractor.ts`](../apps/agent/src/extractor.ts) (`contact` case + `DEFAULT_EXTRACT_TYPES`) |
| Same-surname reconciler guard | [`apps/agent/src/person-names.ts`](../apps/agent/src/person-names.ts) |
| Server REST | [`apps/web/app/api/contacts/`](../apps/web/app/api/contacts/) |
| Server page (SSR) | [`apps/web/app/(app)/contacts/page.tsx`](../apps/web/app/(app)/contacts/page.tsx) |
| Client UI | [`apps/web/app/(app)/contacts/contacts-client.tsx`](../apps/web/app/(app)/contacts/contacts-client.tsx) |
| Lib re-export (server-only) | [`apps/web/lib/contacts.ts`](../apps/web/lib/contacts.ts) |

---

## 8. Future work

- **SMS tool.** `recordContactSent(ownerId, contactId, 'sms')` already speaks
  the protocol; the cell field is normalised; just wire a `sms_send` builtin
  with a provider adapter. The gate will mirror email naturally.
- **Photo-to-contact.** Saskia + `extract_from_image` can already read a
  business card; pairing that with `contact_create` gives a *"add this card
  as a contact"* flow.
- **MCP parity.** The `contact_*` builtins live on the agent runtime side;
  exposing them through `apps/mcp/src/server.ts` for Claude Desktop is the
  natural follow-up.
- **Reconciler title-stripping vs nickname dictionary.** The guard handles
  prefix-overlap (Don/Donald) and titles + initials, but doesn't know about
  unrelated common nicknames (Bob/Robert, Bill/William). Add a nickname map
  if/when that case bites.
