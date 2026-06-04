# Email — inbox, accounts & the contacts gate

Connecting email is what turns Mantle from a notebook into a real second brain:
your correspondence becomes searchable, factual memory the assistant can reason
over and act on. Three screens are involved — **Accounts** (connect), **Contacts**
(the allowlist), **Inbox** (read) — plus **Discover** to find new senders worth
keeping, and the assistant for sending.

## The golden rule: only people you know come in

Mantle **never ingests mail you didn't ask for.** Connecting a mailbox doesn't dump
your inbox into the brain. Instead, **your [Contacts](05-todos-events-contacts-secrets.md)
are the gate**: a message is ingested only if it's *from* someone in your
contacts — or from one of your own account addresses. Everything else is silently
ignored. The same contacts list also decides who the assistant may *email*, so
"who I know" governs your mail in both directions.

> This replaced an older per-sender "approve / deny" system. There's no separate
> senders list anymore — adding a contact is how mail gets let in.

A contact can list **several email entries**, and each entry is either:

- a **full address** — `jane@modular.co` — exactly that person, or
- a **whole-domain wildcard** — `@modular.co` — *anyone* at that domain.

So you can whitelist one person, or trust an entire organisation (your accountant,
your company, your church group) in a single entry. (Wildcards match the exact
domain; `@modular.co` does not include sub-domains like `mail.modular.co` — add
those separately if a sender uses one.)

**Empty contacts ⇒ an empty inbox.** Until you add at least one contact, nothing
new is ingested — by design. The Inbox will nudge you to add one.

## Settings → Accounts (connect a mailbox)

Add an email account with standard IMAP details (host, port, and an **app
password** — not your main password). Most providers (Gmail, Fastmail, etc.) accept
one app password for both reading and sending.

Per account you can set:

- **Folders** to include or exclude (e.g. just `All Mail`, or skip Spam/Trash).
- **First-scan window** — how far back to look on first connect.
- **Sending** — add the SMTP host/port to let the assistant send *from* this mailbox
  (it relays through your provider under your own reputation; Mantle never runs a
  mail server). Credentials are reused from the same app password.

Your app password is sealed (encrypted at rest); the assistant never sees it.
Folder settings only control *which mailboxes get scanned* — the contacts gate
still decides *whose mail* is kept.

## Adding contacts → mail flows in (with a backfill)

Add a contact in **Contacts** (or just tell the assistant "save Jane at Modular,
jane@modular.co"). The moment you add an email or `@domain` to a contact:

1. their **future** mail starts being ingested, and
2. Mantle **backfills the last 90 days** from that address/domain in the
   background, so their recent history lands in the brain right away.

## Discover (find senders worth adding)

Don't know who's been trying to reach you? **Discover** (under *Review* in the
sidebar, or the Discover link in the Inbox) does a live scan of your mailbox and
lists recent senders who **aren't** in your contacts yet — newest first, with how
many messages and the latest subject. One click adds any of them as a contact
(which triggers the backfill above). Nothing is stored by the scan itself; it just
reads the server on demand.

## Inbox (read what came in)

Ingested mail lives under **Inbox**, organised by account and folder. Each message
is also a full memory node — so you can search it, the assistant can cite it, and
its **attachments become real files** in your brain (PDFs read, images described).
Ask the assistant "what did the builder quote?" and it finds the thread and gives
you the number.

Newsletters and automated mail from a contact still come in, but Mantle tags every
message by **delivery kind** (`direct` / `list` / `automated` / `marketing`) and
**down-weights** the bulk ones in search — so a contact's newsletter can't crowd
out their real correspondence. It's a down-weight, never a filter: an explicit
search still finds it.

## Sending email

The assistant can **draft and send** from your mailbox — "reply to this and say I'll
be there," "email Don the summary." Two tools power it: a plain send and a
**send-a-Page** (which mails a richly formatted [Page](04-pages-tables-notes-docs.md)
as proper HTML, inline images and all).

**Who it may email is the same contacts list** — but only the *concrete addresses*
(you can't send to a whole `@domain`). With no contacts the send gate is open
(bootstrap); once you have contacts, the assistant may only email your own
addresses and people in your contacts. If you've marked the send tool as requiring
approval, each send waits for you under **Pending**.

## How email becomes memory

An ingested message rides the same pipeline as everything else: it's summarised,
embedded for meaning-search, mined for facts ("the quote was R12,400"), and its
people/companies are added to the knowledge graph — with the original message kept
whole and citable. See [The brain](../02-concepts/01-the-brain.md).
