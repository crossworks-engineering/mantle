---
title: Pending approvals
---

## Pending approvals

This is where agents wait for you. Nothing listed here has happened yet. Two
kinds of item land here:

- **Tool approvals.** An agent asked to run a tool that needs your
  confirmation. Open the args to see exactly what it will do, then press
  **Approve & run** or **Reject**.
- **Questions.** A background run stopped to ask you something, or ran out of
  budget and needs a decision. These show as a short form to fill in.

Read the arguments, not just the tool name, on anything that sends, deletes or
spends. Each card links to the trace of the turn that asked for it.

If a card says **Previous decision bounced**, your earlier decision was
recorded but the tool did not run. Decide again.

Decided items move to the history below, with their result.

## Assistant

Agents in Jackdaw cannot approve or reject anything here; that would let an
agent approve its own request. An MCP client signed in as you can, when you ask:

- "What is waiting for my approval?"
- "Reject the pending email to the supplier."

It uses `pending_list`, `pending_get`, `pending_approve` and `pending_reject`.

## Technical

A tool asks for approval when its **Requires operator confirm** switch is on
(Settings > Tools). The check runs in the tool loop before the tool executes:
the call is saved as a pending row in `pending_tool_calls` and the agent's turn
carries on without the result. Approving runs the tool with the exact stored
arguments and writes the result back to the row.

Questions from runs use the same queue. The run waits without holding a
worker, and your answer resumes it where it stopped.
