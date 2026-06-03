# Observability — traces, journey & debug

Mantle is built on a hard rule: **nothing happens to your data without a record of
it.** Every assistant turn, every extraction, every reminder leaves a trace you can
inspect — what ran, in what order, how long it took, and what it cost. This is what
makes the system auditable instead of a black box.

## Traces

A **trace** is one unit of work (an assistant turn, an extraction run, a summariser
pass…), broken into ordered **steps** (database reads/writes, model calls,
embeddings, sends). Each trace rolls up tokens in/out, cached tokens, cost, duration,
and status.

The **Traces** screen lets you filter by status/kind/time and sort by cost or
duration; opening one shows the step tree as a diagram, with the input/output of
each step. When you want to know *exactly* how the assistant arrived at an answer —
including any specialist agents it delegated to, and what each leg cost — this is
where you look.

## Node history

Most items have a **history** view that gathers every trace that touched that
specific node — its ingestion, summary, fact extraction, graph links — into one
timeline. "What did the brain do with this email?" answered in one place.

## Debug dashboards

The **Debug** area is a set of operational dashboards:

- **Overview** — health at a glance: recent activity, spend, cache hit rate, errors.
- **Spend** — token spend over time, broken down by model and by agent.
- **Topics / Digests / Facts** — what the brain has learned and rolled up.
- **Agents** — per-agent activity and cost.
- **Telegram** — chat/account state.
- **Journey** — see below.
- **Integrity** — see below.

## Journey

**Journey** is the action → reaction feed: one row per thing that happened (you
typed, a file arrived, an email landed) and what the brain did in response (which
memory layers it touched, the cost). It has a live "active now" header so you can
watch ingestion happen in real time, and it flags anything that stalled or failed.
Filter by pipeline (content vs conversation vs automation) and hide no-ops.

## Integrity

**Integrity** is a self-audit surface. A **Live** view lets you add a piece of
content and watch its full memory footprint appear (summary, embedding, chunks,
facts, graph) — and remove it. A **Corpus Audit** scans for invariant violations
across everything you've stored. Useful for confidence that the brain is healthy,
and for spotting anything that didn't index correctly.

## Pending

When the assistant wants to use a tool you've marked as **requiring approval**, the
action waits in **Pending**. You inspect the exact arguments and approve or reject.
It's the human-in-the-loop checkpoint for consequential actions (see
[Skills & tools](../04-configuring/02-skills-and-tools.md)).

## Cost transparency

Because every model call is metered into its trace, Mantle can tell you what
*anything* cost — a single turn, a day of ingestion, or per-agent/per-model totals on
the Debug → Spend view. Delegated work is attributed to the specialist that did it,
so the numbers stay honest. (The deep reference for the tracing layer is
`docs/observability.md` in the repo.)
