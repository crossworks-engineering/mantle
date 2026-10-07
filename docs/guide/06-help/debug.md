---
title: Debug
---

## Debug

Debug is the operator's view of the brain. Each tab answers one "is this working?" question.

- **Spend**: model cost for the last 7 days, by model and by agent.
- **Topics**, **Digests** and **Facts**: topics found in your chats, the summaries written of them, and the facts pulled from your content.
- **Context**: for a turn, the question, the context the agent was given and the reply.
- **Agents** and **Telegram**: your agents and their activity, and paired Telegram chats and their traffic.
- **Journey**: each action and what the brain did in reaction to it.
- **Integrity**: a live view, a **Corpus audit** for orphans and mismatches, the system config, and **Maintenance** tasks.
- **Tool validation**: tool calls whose arguments the validator flagged.
- **Sanity check**: read-only checks of config and setup. Each failure shows a fix.

Use it when search misses something you know is there. The tabs show whether the content was never extracted, extracted into facts that do not match your question, or never embedded.

## Assistant

The assistant has no tools for this screen. Open it here.

## Technical

- Figures come from the same tables the features use, so a number that disagrees with another screen is a real problem.
- Spend is summed from each traced model call. Follow it down to single turns on the Traces screen.
- Maintenance tasks can change data. Preview first, look at sample rows, then apply.
- See [Traces, debug and integrity](../05-admin/09-observability.md).
