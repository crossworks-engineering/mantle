---
title: Debug
---

## Debug

The instrument panel. A dozen tabs, each answering a different "is this actually
working?" question about the brain.

The ones people use most: **Spend** breaks costs down far enough to attribute
them. **Facts** and **Topics** show what extraction has actually made of your
content, which is the difference between "it stored the document" and "it
understood it". **Context** shows what an agent receives before it answers.
**Integrity** compares real content against its brain footprint and audits the
corpus for orphans and inconsistencies.

Nothing here is required reading. It's the screen for when something is off and
the ordinary surfaces all look fine.

## When to use this

When retrieval disappoints. Search failing to find something you know exists is
usually one of three things, and these tabs separate them: the content was never
extracted, it was extracted into facts that don't match how you asked, or it was
never embedded at all.

When spend jumps. Ordinary use doesn't change cost much; a worker pointed at a
new model does, and Spend attributes it.

Before any cleanup, **sample first**. The audit tools can identify a large set of
rows to remove, and a count is not evidence that the set contains what you think
it does. Look at rows, then act.

## Technical

The figures come from the same tables the features use, not from a separate
metrics store, so a number here disagreeing with a feature screen is a real
inconsistency worth chasing rather than a reporting lag.

Costs are rolled up from individual traced calls at the model's price, so any
figure on the spend tab can be followed down to the specific turns that produced
it on the traces screen.

The integrity view is deliberately **passive**: it reads and reports, and the
destructive operations are separate, explicit maintenance actions. The corpus
audit finding a problem is information, not an instruction, a node with no
embedding may be waiting for a worker rather than broken.

Sanity check and tool validation exercise real paths rather than inspecting
configuration, which is why they can catch a tool whose definition is valid and
whose endpoint has quietly moved.
