# Email — inbox, accounts & senders

Connecting email is what turns Mantle from a notebook into a real second brain:
your correspondence becomes searchable, factual memory the assistant can reason
over and act on. Three screens are involved — **Accounts** (connect), **Senders**
(approve), **Inbox** (read) — plus the assistant for sending.

## The golden rule: nothing comes in uninvited

Mantle **never ingests mail you didn't ask for.** Connecting a mailbox doesn't dump
your inbox into the brain. Instead, every sender starts as *pending*, and only mail
from senders you've **approved** flows into memory. This is the security gate, and
it's deliberate — your brain holds what you choose, not every newsletter you ever
received.

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

## Settings → Senders (the approval gate)

This is where you curate who counts. Senders are **pending**, **allowed**, or
**denied**:

- Approve a sender → their messages ingest into memory (and backfill).
- Deny a sender → their mail is ignored.

To help you triage, Mantle tags each sender's mail by **delivery kind** —
`direct`, `list`, `automated`, `marketing` — shown as a pill once there's enough
signal. There's a one-click **"deny all marketing senders"** bulk action on the
pending list, and filters to focus on one kind. Classification is header-based and
runs even before you approve anyone, so the pills are useful immediately.

## Inbox (read what came in)

Ingested mail lives under **Inbox**, organised by account and folder. Each message
is also a full memory node — so you can search it, the assistant can cite it, and
its **attachments become real files** in your brain (PDFs read, images described).
Ask the assistant "what did the builder quote?" and it finds the thread and gives
you the number.

## Sending email

The assistant can **draft and send** from your mailbox — "reply to this and say I'll
be there," "email Don the summary." Two tools power it: a plain send and a
**send-a-Page** (which mails a richly formatted [Page](04-pages-tables-notes-docs.md)
as proper HTML, inline images and all).

**Who it may email is gated by your [Contacts](05-todos-events-contacts-secrets.md).**
With no contacts, the gate is open (bootstrap). Once you have contacts, the
assistant may only email your own addresses and people in your contacts list —
adding a contact unlocks emailing them, deleting one revokes it. And if you've
marked the send tool as requiring approval, each send waits for you under
**Pending**.

## How email becomes memory

An approved message rides the same pipeline as everything else: it's summarised,
embedded for meaning-search, mined for facts ("the quote was R12,400"), and its
people/companies are added to the knowledge graph — with the original message kept
whole and citable. See [The brain](../02-concepts/01-the-brain.md).
