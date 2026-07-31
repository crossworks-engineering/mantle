---
title: Contacts
toolGroups: [contacts, email]
---

## Contacts

The people and organisations you deal with — name, company, phone, and one or
more email addresses.

Contacts do a second job that surprises people: they are the **email gate, in
both directions**. Mail is only ingested from addresses on this list, and the
assistant may only send to addresses on this list. Adding a contact is what
turns their mail on; removing one turns it off.

An entry can be a full address (`sam@acme.com`) or a whole domain
(`@acme.com`, meaning everyone there). Each contact also carries a description
the assistant reads, which is where context like "our electrician, only works
Tuesdays" belongs.

## Assistant

- "Add Sam Delport at Acme, sam@acme.com."
- "What's the number for the electrician?"
- "Email Sam the quote."

Two consequences of the gate worth knowing. If mail from someone isn't arriving,
the usual reason is that they aren't a contact — not that ingest is broken. And
the assistant physically cannot email a stranger, so "send this to
someone@nowhere.com" fails by design rather than by accident.

## Technical

A contact is an ordinary node with typed fields, so it is searchable and
embeddable like everything else. What makes it special is `data.emails` — the
array consulted by both halves of the mail pipeline.

Inbound, the IMAP sync checks each message's sender against the allowlist before
anything is stored, so non-contact mail is never written to the brain at all.
Outbound, `email_send` resolves the recipient against the same list and refuses
otherwise, then sends through your provider's SMTP using the same app password
the IMAP account already holds. Mantle never runs a mail server of its own.

Because the list is a gate rather than a filter, it is also the privacy control:
the way to stop ingesting someone is to remove them here.
