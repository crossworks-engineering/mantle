---
title: Notes
toolGroups: [notes]
---

## Notes

Quick markdown notes — the fastest way to get something into the brain.

Use a note when you want the knowledge captured more than you want it
formatted: a phone number someone read out, what a supplier quoted, how a
machine was behaving before it failed. No structure required, no draft step,
no ceremony.

If a note grows into something you'd hand to someone else, it can become a
page later. Start here anyway; the cost of writing it down should be near zero.

## Assistant

- "Make a note that the borehole pump was cycling every 4 minutes today."
- "Add to the supplier note: they quoted R18k, two-week lead time."
- "What did I write down about the borehole?"

Appending to an existing note is a first-class move, not a rewrite — so a note
works as a running log you keep adding to over weeks. Ask it to add rather than
to update and you'll keep the history.

Deleting notes is deliberately not something the assistant can do.

## Technical

A note is the simplest node in the system: markdown body, title, tags. That
simplicity is why it's the cheapest thing to ingest — there's no document model
to normalise and no draft state to reconcile.

On save it goes through the same ingest path as everything else. A local model
writes a summary and pulls out structured facts and entities; the body is
chunked and embedded; the chunks land in the index. From that point the note is
reachable three ways: by search, by semantic retrieval during a conversation,
and by the facts extracted out of it, which can surface even when the note
itself doesn't.

That extraction happens **once, at write time**, rather than each time something
is read. It costs a little on the way in and makes every later read cheap and
deterministic — the same reason the rest of the system prefers doing work on
ingest.
