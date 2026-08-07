---
title: Worker groups
---

## Worker groups

A named set of worker agents that a background run can call **as a panel**
rather than one at a time.

The point isn't parallelism, it's disagreement. A run step aimed at a group
fans out into one independent attempt per member, and then a further step reads
all the attempts together and judges them. Three agents that each drafted a
solution without seeing the others is a materially different input from one
agent's answer; you find out where they agree, which is roughly where you can
trust the result.

Groups are only meaningful inside the runner. Nothing on this screen affects
what your assistant does in ordinary conversation.

## Before you change anything

Membership is what a panel costs. Every member is a full model call on every
step aimed at the group, so a five-member group is five times the spend of one
worker, and the audit step on top. Two or three members is usually where the
value is.

Composition matters more than size. A panel of the same model at the same
temperature produces three copies of one opinion, which is the expensive way to
learn nothing. Vary the model, or vary the prompt, or don't use a panel.

Only enabled worker agents are eligible for membership, so disabling a worker
elsewhere quietly shrinks any group it was in.

## Technical

A group reference in a run step is expanded when the run is planned, not when it
executes. It becomes an ordinary parallel block of one attempt per member,
followed by a panel-audit step in the enclosing sequence, so the engine only
ever runs shapes it already knows how to run, and a group introduces no new
execution semantics to reason about.

The audit step is given every attempt in full, plus a mechanical ledger of what
each one did. A verdict of `pass` means at least one attempt is usable, and the
directive it produces **is** the authoritative synthesis, downstream steps read
that, not the individual attempts.

A blocking verdict escalates to a human rather than retrying. Panels never rerun
automatically, on the same principle that governs sequential steps: an automatic
retry of a step that several independent attempts already failed is unlikely to
be the thing that fixes it, and is very likely to be expensive.
