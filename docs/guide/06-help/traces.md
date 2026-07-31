---
title: Traces
---

## Traces

Every turn the system has taken, step by step — what was asked, which tools ran
with what arguments, what came back, how long it took and what it cost.

A trace is the whole story of one turn rather than a log line from it. When the
assistant does something surprising, this is the only place that shows the
actual sequence: the prompt, the tool calls in order, each result as the model
received it, and the reply that followed.

Filters cover kind, status, time window, and sorting by cost or duration —
which makes this the practical way to find your expensive turns as well as your
broken ones.

## When to use this

Two questions bring people here. *Why did it do that?* — read the tool calls in
order and the answer is almost always visible, usually a tool returning
something other than what its name implies. And *why did that cost so much?* —
sort by cost and the outliers are typically one turn that pulled far more
context than it needed.

Sorting by duration finds a different problem: slow tools rather than expensive
models.

Trace ids appear on other screens — a pending approval carries one — so you can
follow a single action back into the full turn that produced it.

## Technical

Tracing wraps the tool dispatcher and the model calls, so a trace is produced by
the same code path that does the work rather than by a parallel logging layer.
There's no configuration to enable it and no sampling to miss the turn you care
about.

Costs are computed from the provider's reported token usage at the model's
price, per call, and rolled up — so a trace's cost is the sum of its real calls
rather than an estimate. That's what makes the debug spend figures reconcilable
against a provider invoice.

Tool arguments and results are stored as they were passed, which is what lets
you see the exact input a model produced. It also means a trace can contain
content from your brain, so treat the trace log with the same care as the data
it touched.

Federated reads and team turns are traced too, under their own kinds — a peer's
query and a team member's question are both fully visible here.
