# See what the brain did

Every assistant turn, extraction and background job leaves a record in Jackdaw. These screens show what ran, in what order, how long it took and what it cost.

| Screen | Where | Use it to |
|---|---|---|
| **Traces** | menu, System | Open one turn or job step by step: the prompt, each tool call and result, the model, tokens, cost and time. Sort by cost or duration to find expensive or slow turns. |
| **Debug** | menu, System | Health dashboards (tabs below). |
| **Audit log** | Settings | See who did what and when: logins, agents, MCP clients, members and clients. |
| **Config** | Settings | Compare your agents, skills, tools and workers with what the release ships. Shows what an update added and what you changed. |

## Debug tabs

| Tab | Shows |
|---|---|
| **Overview** | Traffic, spend, embedding cache and failures at a glance. |
| **Spend** | Token cost by model and by agent, last 7 days. |
| **Context** | For each turn: the question, the context sent to the model and the reply. |
| **Journey** | Each thing that happened (a message, a file, an email) and what the brain did in response, live. |
| **Integrity** | **Live brain activity** shows each new item's summary, embedding, chunks and facts as it lands. **Corpus audit** scans everything stored for broken records. |
| **Sanity check** | Configuration checks, each failure with its fix. |
| **Topics**, **Digests**, **Facts** | What the brain has learned and rolled up. |
| **Agents**, **Telegram** | Agent activity, and paired Telegram chats. |
| **Tool validation** | Tool calls the argument checker flagged. |

## Common questions

- **Why did the assistant answer that?** Open the turn in **Traces**, or check **Debug > Context** for what it was given.
- **Why is an item not found in search?** Open **Debug > Integrity** and check the item got a summary and an embedding.
- **What is costing money?** **Debug > Spend**, then sort **Traces** by cost.
- **Did the update land?** **Settings > Config** lists anything missing.
- **Who changed this?** **Settings > Audit log**, filtered by action and date.

Container logs on the box are covered in [Troubleshooting](11-troubleshooting.md).

## Next

- [Traces screen help](../06-help/traces.md)
- [Debug screen help](../06-help/debug.md)
