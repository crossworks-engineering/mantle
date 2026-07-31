---
title: Config
---

## Config

A sanity check. It diffs your brain's live configuration — agents, skills, tool
groups, workers — against the template the product ships, and tells you per item
whether it's **OK**, **missing**, **modified** or **added**.

This is the screen that answers "did that upgrade actually land?" and "what have
I changed since I installed this?". Both questions are otherwise surprisingly
hard, because configuration accretes: you adjust a prompt in Studio, a release
adds a specialist, and six months later nobody knows which differences were
deliberate.

It is **read-only until you act**. Nothing is adopted without you choosing it,
per item or all at once.

## When to use this

After an upgrade, and when something behaves oddly for no reason you can find.

Read the four states as intent, not as errors. **Missing** usually means a new
default arrived that your brain never got. **Modified** usually means *you*
changed it on purpose — adopting would overwrite your version, so that's the one
to think about rather than click through. **Added** is your own work and is
supposed to be there.

Commit-all is safe on a brain you haven't customised and destructive on one you
have. If you've been editing prompts in Studio, adopt item by item.

## Technical

The comparison is anchored on the **effective persona** rather than a fixed
slug, so a brain whose assistant was renamed still compares against the right
template instead of reporting everything as missing.

The shipped template is the system manifest — one declaration of the default
agent, skill, tool-group and worker graph, with three consumers: a drift test in
CI, the seeder that provisions a fresh brain, and the checker behind this
screen. That's why the diff is trustworthy: it's comparing against the same
thing that would be installed today, not a document describing it.

Adoption writes the template's version of one item. It doesn't reconcile
anything else, so adopting a skill won't silently re-grant tool groups you
removed on purpose.

Content is never part of this. Your notes, pages, tables and seeded example
material are owner space — the manifest governs the system graph and stops at
the boundary of things you wrote.
