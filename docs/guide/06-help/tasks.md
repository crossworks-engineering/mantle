---
title: Tasks
toolGroups: [tasks]
---

## Tasks

Tasks are the things you need to do, each with a status, a priority and an
optional due date. It is a plain list the assistant can read and add to while
you talk, so a promise made in conversation is not lost.

- **New task** opens the form: **Title**, **Status** (To do, In progress,
  Blocked, Done), **Priority** (low, normal, high), **Due**, **Tags** and
  **Notes**.
- Switch between the list and the board. The board has three columns; Blocked
  is a flag set from the form, not a column.
- Overdue tasks are flagged on the list. **Mark done** closes a task.
- A task can have a checklist and a comment thread.

## Assistant

- "Add a task: order the replacement seal, high priority, due Friday."
- "What's overdue?"
- "Mark the seal task done."
- "Add a comment to the seal task: supplier says two weeks."

If you say "I must remember to chase the invoice", ask the assistant to make it
a task.

## Technical

A task is an item in the brain with status, priority and due-date fields, and
it is indexed like everything else, so search matches both the task text and
the people and places it mentions. The assistant uses `task_list`,
`task_get`, `task_create`, `task_update`, `task_delete`, `task_comment_add`
and `task_comments_list`.

Tasks do not remind you on their own. Reminders come from events, and anything
that should reach you unprompted is a heartbeat: a scheduled agent turn that
can read your tasks and message you.
