---
title: Discover senders
toolGroups: [contacts, email]
---

## Discover senders

A live look into your mailbox at the people who have written to you recently and
are **not** in your contacts.

It exists because of how the mail gate works: Mantle only ingests mail from
addresses on your contacts list, so anyone not on it is invisible to the brain
no matter how much they've sent. That's the right default; it's the privacy
control, but it means there's no way to notice a missing contact from inside
Mantle. This screen is that way.

Each row is a sender with a count and a recent subject, and one action: add them
as a contact. From the moment you do, their mail starts flowing into the brain.

## Assistant

- "Who's been emailing me that I haven't added?"
- "Add that supplier to my contacts."

Worth knowing: adding a contact turns their mail on **going forward**. It does
not reach back and ingest the older messages this screen is showing you; those
were never stored. If the history matters, forward the thread to yourself after
adding them.

## Technical

The scan runs against IMAP directly and reads nothing from the brain, because
by definition none of this mail is in the brain. It's a read-only look at the
mailbox: sender addresses and subjects are pulled to build the list and are not
persisted anywhere.

That's also why the screen can feel slow compared with the rest of the app,
it's talking to your mail provider live, not to a local index.

Promoting a sender creates an ordinary contact with that address in its email
list, which is the same list the outbound gate checks. So adding someone here
also makes them a valid recipient for anything the assistant sends. If you want
to receive from someone without ever mailing them, that distinction doesn't
exist, one list governs both directions.
