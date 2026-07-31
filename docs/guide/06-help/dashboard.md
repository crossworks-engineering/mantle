---
title: Dashboard
toolGroups: [brain-health]
---

## Dashboard

Not a summary of your content — a health readout of the **brain**. Everything
here answers "is the thing that remembers for me working, and what is it
costing?"

The four cards at the top are the ones to learn. **Vectors indexed** is how much
of your corpus is actually searchable, broken down into nodes, facts and
entities. **Brain nodes** is the raw size of the graph. **Spend** compares the
last seven days against the seven before them, so a model change that doubled
your costs shows up as a trend rather than a number you have to remember.
**Pending review** is the only card that means someone has to do something.

Below them: spend and ingest over thirty days, a capacity dial, a breakdown by
node type and entity kind, and the ops panels — email, Telegram, heartbeats,
recent errors and failures. The panels are where a quietly broken background job
becomes visible; nothing else in the app will tell you a heartbeat has been
failing for a week.

## Assistant

- "How big is my brain now?"
- "Am I close to needing a second brain?"
- "How's retrieval quality looking?"

The assistant reads the same capacity figure the dial does, so asking is a real
alternative to visiting the screen. What it cannot do is act on any of it — the
dashboard's job is to send you somewhere, and both the spend card and the
pending card are links for that reason.

## Technical

Everything on the screen comes from a single `GET /api/dashboard` call that
bundles the counts, the thirty-day series, the integrity check and the ops
stats. One request rather than a dozen, because a health page that hammers the
database is its own kind of problem.

The capacity dial measures your corpus against the **split policy**: roughly
twenty thousand documents, or a hundred thousand passage vectors, per brain.
That ceiling is a retrieval-quality limit, not a storage one — embeddings are
768-dimension vectors and search stays sharp while the corpus is small enough
for a nearest-neighbour scan to be meaningful. Passing it means it's time to
split into a second brain, not to buy a bigger disk.

The integrity figures come from the same graph checks that back the corpus audit
on the debug screen, so a number that looks wrong here can be investigated
there rather than guessed at.
