---
title: Team
toolGroups: [team-admin]
---

## Team

Your window into the outside surface, the forum where people you've given a
team token can ask your brain questions.

Team membership is **a role a contact holds**, not a separate user account. You
mint a token from a contact; that token is the only credential they ever get,
and deleting it revokes their access mid-session. There is no user list to
maintain in parallel with your contacts.

The tabs answer different questions. **Members** reads person-first: one
person's posts, each paired with the answer it drew, plus the topics they
started and the requests they filed. **Topics** reads thread-first, including
the private ones. **Requests** is the review queue, the one thing a team member
can cause to be written. **Shared links** and **Settings** cover what else is
exposed and how.

## Assistant

- "What has the team been asking about this week?"
- "Has anyone raised anything about the pump job?"

The assistant can read the team surface (members, threads, and the access log)
because you hold the admin group. The team responder that answers *them* is a
different agent with a different, much smaller grant, and it cannot read this
screen's view of things.

## Technical

The trust boundary is the **brain**, not the person. A team member can read
whatever the team responder can read, which is deliberately a wide read-only
surface: search, files, notes, pages, tables, events, tasks, contacts and app
data. There are no per-member tiers inside a brain, if two groups of people
must not see each other's material, that's two brains.

The responder holds exactly **one** write: filing a change request into your
review queue, provenance-stamped with who asked. Everything else, all other
writes, delegation, terminal, sending, and bulk export, is excluded by design.
Bulk export is excluded specifically because it makes exfiltration a single
call rather than a grind.

Your private corpus is a further step in. Email and journal reads are granted to
the responder but gated at run time behind a switch on this screen's Settings
tab, **off by default**. Turning it on is what lets a team member's question
reach your mail; leaving it off means those tools exist and refuse.

Every member request re-checks membership liveness, which is what makes token
deletion take effect immediately rather than at the next login.
