---
title: Pending approvals
---

## Pending approvals

The queue where the assistant waits for you. Two different things land here, and
they're worth telling apart.

**Tool approvals**: a tool marked as needing confirmation was requested, and
nothing has happened yet. You see which tool, and the arguments it wants to run
with, before you decide. Approve and it executes immediately; reject and it
never runs.

**Questions**: a background run has stopped to ask you something, or has hit
its budget ceiling and wants permission to keep going. These render as a small
form rather than an approve/reject pair, because a run usually needs an answer,
not a verdict.

The important property: a request sitting here has **not** happened. The queue
is a gate, not a log of things already done, the history at the bottom of the
screen is that.

## When to use this

Check it when the dashboard's pending card is non-zero, and read the arguments
rather than the tool name. The tool name tells you the *kind* of action; the
arguments tell you what it will actually do, and that's the part worth a second
of attention on anything that sends, deletes, or spends.

An approval you've made can occasionally bounce back needing to be re-decided,
that shows as a loud warning on the row. It means the decision was recorded but
the execution didn't settle, so nothing ran. Decide again.

## Technical

Approval is enforced in the tool loop, not in the UI. A tool whose registry row
carries `requires_confirm` never dispatches inline, the loop writes a pending
row and the agent's turn continues without the result. That's why gating a tool
is safe: there is no path where the agent talks its way past the gate, because
the gate is upstream of the code that would run it.

Approving dispatches the tool with the exact arguments stored on the row, and
the result is written back to it. The row keeps its trace id, so any approval
can be followed into the full turn that requested it.

Which tools are gated is per-tool and editable; it's a flag on the tool
registry row, so you can require confirmation on anything you want a look at
first. Tools an agent mints for itself cannot quietly clear the flag; approval
requirements set by the operator win over an agent's own preference at creation
time.

Runner questions arrive through the same queue but a different mechanism: the
run engine suspends durably, so a question can sit unanswered indefinitely
without losing the run's place. Answering resumes it exactly where it stopped.
