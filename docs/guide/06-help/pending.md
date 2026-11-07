---
title: Pending approvals
---

## Pending approvals

This is where agents wait for you. Nothing listed under **Awaiting decision**
has happened yet. Two kinds of item land here:

- **Tool approvals.** An agent asked to run a tool that needs your
  confirmation. Open the args to see exactly what it will do, then press
  **Approve & run** or **Reject**.
- **Questions.** A background run stopped to ask you something, or ran out of
  budget and needs a decision. These show as a short form to fill in.

Read the arguments, not only the tool name, on anything that sends, deletes or
spends. Each card links to the trace of the turn that asked for it
(**originating trace**).

A card can carry a note:

- **Needs an Admin user**, with the reason. The person who asked cannot
  approve their own call: they see "You asked for this call, so an Admin user
  approves it."
- **Asked after reading text a client wrote.** The turn read text from
  outside before it asked. Check it is a request you made.
- **Previous decision bounced.** Your earlier decision was recorded but the
  tool did not run. Decide again.

When an MCP client replaces or deletes a key in the vault (Settings > API
keys), the change waits here too. The card names the key, its kind, its
target and a masked preview, never the value. Adding a new key does not wait.

Decided items move to **History**, with their result. You can also decide from
the Telegram card.

## Assistant

Agents in the app cannot approve or reject anything here; that would let an
agent approve its own request. An MCP client signed in as you is your agent,
not you, so it cannot approve either. It can read what waits and reject, when
you ask:

- "What is waiting for my approval?"
- "Reject the pending email to the supplier."

It uses `pending_list`, `pending_get` and `pending_reject`. To approve, use
this screen or the Telegram card.

## Technical

A tool asks for approval when its **Requires operator confirm** switch is on
(Settings > Tools). The check runs in the tool loop before the tool executes:
the call is saved as a pending row in `pending_tool_calls` and the agent's turn
carries on without the result. Approving runs the tool with the exact stored
arguments and writes the result back to the row.

A vault key change is sealed on the key's row while it waits. Approving makes
the change through the vault's one write door and runs its checks again. Any
other write to the key makes the hold stale, and a rejection drops it.

Questions from runs use the same queue. The run waits without holding a
worker, and your answer resumes it where it stopped.
