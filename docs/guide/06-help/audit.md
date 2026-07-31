---
title: Audit log
---

## Audit log

Who did what, when — filterable by actor, action and date range.

The value here is that it spans the different kinds of actor a Mantle has. A
login is one. The assistant acting on your behalf is another. A connected MCP
client, a peer's Mantle asking a federated question, a team member's request —
each shows up as itself rather than being flattened into "the system".

That's the question this screen actually answers: not "what happened" — plenty
of screens show that — but "what caused it".

## When to use this

Reach for it when something exists that you don't remember creating, or when
something you expected is gone. Filter by action first and narrow by date;
filtering by actor is only useful once you know which kind of actor to suspect.

It's also the screen to check after you disconnect an MCP client or delete a
peer, since it shows what that connection had been doing while it was live.

Note that this is a record of actions, not a record of content. It tells you a
node was deleted and by whom; it does not hold a copy of what was in it.

## Technical

Entries are written by the action paths themselves rather than reconstructed
from database changes, which is what lets an entry carry intent — the actor, the
surface it arrived on, and the operation as it was requested.

The log is append-only in practice: nothing in the application updates or
deletes a row here. That's what makes it worth consulting after a suspected
problem, since an actor able to cover its tracks would make the whole thing
decorative.

Queries run server-side with the filters and page in the URL, so a particular
view is a link you can keep or share with someone helping you diagnose
something.

Cross-Mantle reads are traced here too, which is the audit half of federation:
a category grant to a peer is a standing subscription you can't see the use of
anywhere else, and this is where its use shows up.
