---
title: Debug
---

## Debug

Debug is the operator's view of the brain. Each tab answers one "is this working?" question. The list on the left shows each tab with the one number worth knowing before you open it.

- **Overview**: traffic in the last 24 hours, token spend, the embed cache and failures over 7 days, and duplicate edges.
- **Spend**: model cost for the last 7 days, by model and by agent.
- **Topics**, **Digests** and **Facts**: topics found in your chats, the summaries written of them, and the facts pulled from your content.
- **Context**: for a turn, the question, the context the agent was given and the reply.
- **Agents** and **Telegram**: your agents and their activity, and paired Telegram chats and their traffic. A Telegram chat can be set to answer with a different agent.
- **Journey**: each action and what the brain did in reaction to it.
- **Integrity**: **Live** shows what lands in the brain as you add it, **Corpus audit** scans for orphans and mismatches, **System config** shows the settings, and **Maintenance** runs repair tasks.
- **Tool validation**: tool calls whose arguments the validator flagged.
- **Sanity check**: read-only checks of config and setup. Each failure shows a fix. It runs when you open it.

Use it when search misses something you know is there. The tabs show whether the content was never extracted, extracted into facts that do not match your question, or never embedded.

## Assistant

The assistant has no tools for this screen. Open it here.

## Technical

- Figures come from the same tables the features use, so a number that disagrees with another screen is a real problem.
- Spend is summed from each traced model call. Follow it down to single turns on the Traces screen.
- Maintenance tasks can change data. Preview first, look at sample rows, then apply.
- See [Traces, debug and integrity](../05-admin/09-observability.md).
