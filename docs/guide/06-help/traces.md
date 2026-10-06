---
title: Traces
---

## Traces

A trace is the full record of one piece of work: what was asked, which tools
ran with which arguments, what came back, how long it took and what it cost.
Open one when the assistant does something you did not expect.

Filter the list by:

- **Kind**: Responder, Heartbeat, Extractor, Summarizer, Reflector, Ingest,
  Photo, Federation or Run item.
- **Status**: Success, Error, Running or Skipped.
- **Time**: the last 1h, 6h, 24h, 7d or 30d.
- **Sort**: Newest, Oldest, Costliest, Cheapest, Slowest or Fastest.

To find out why the assistant did something, read the tool calls in order. To
find out why something cost a lot, sort by Costliest. Sort by Slowest to find
slow tools.

Other screens link here by trace id, for example a card in Pending approvals,
so you can follow one action back to the turn that caused it.

## Assistant

The assistant cannot read traces. Open a trace yourself, or ask about how
tracing works:

- "What does a Skipped extractor trace mean?"
- "How is a trace's cost worked out?"

## Technical

Traces and their steps are stored in the `traces` and `trace_steps` tables.
Tracing wraps the tool calls and model calls themselves, so nothing needs
switching on and no turn is sampled out. Each model call's cost comes from the
provider's reported usage, or from a price table when the provider reports
none, and adds up to the trace total.

Tool arguments and results are stored as they were passed (a secret's value is
hidden), so a trace can hold content from your brain. Treat the trace log with the same care as your data.
Requests from peers are traced too, as the Federation kind.
