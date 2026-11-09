---
title: Tasks
toolGroups: [tasks]
---

## Tasks

Tasks are the things you need to do, each with a status, a priority and an
optional due date. It is a plain list the assistant can read and add to while
you talk, so a promise made in conversation is not lost.

- **New** opens the form: **Title**, **Status** (To do, In progress,
  Blocked, Done), **Priority** (low, normal, high), **Due**, **Tags** and
  **Notes**. Then **Save task**.
- Tasks sit in folders. **New task inside** on a folder's menu makes one there.
- Switch between the list and the board. The board has three columns: To do,
  In progress and Done. Drag a card to change its status. A blocked task sits
  under In progress with a badge.
- Overdue tasks are flagged on the list. **Mark done** closes a task, and
  **Reopen** puts it back.
- Open a task to add a **Checklist** of steps. Notes on progress go in the
  task's **Notes**.
- **Archive** hides a finished task without deleting it. **Archived** shows
  them again.

**Files on a task.** A task can hold up to 5 files: screenshots, logs and
PDFs.

- Drop a file on an open task, paste a screenshot (Ctrl or Cmd+V), or use
  **Attach**.
- Types: png, jpg, gif, webp, pdf, txt, log, md, json and csv. Each file can
  be at most 10 MB.
- Who can read the task can open its files. Who can edit the task can add or
  remove a file.
- Archiving a task keeps its files. Deleting a task deletes its files too.
- The files sit in **Files > Auto-filed > Task files**, one folder per task,
  where Admin users can see them. They are stored by name only: Mantle does
  not read them into the brain.

## Assistant

- "Add a task: order the replacement seal, high priority, due Friday."
- "What's overdue?"
- "Mark the seal task done."
- "Note on the seal task: supplier says two weeks."
- "Look at the screenshot on the seal task. What does the error say?"

If you say "I must remember to chase the invoice", ask the assistant to make it
a task.

## Technical

A task is an item in the brain with status, priority and due-date fields, and
it is indexed like everything else, so search matches both the task text and
the people and places it mentions. The assistant uses `task_list`,
`task_get`, `task_create`, `task_update` and `task_delete`. Tasks have no
comments: progress goes in the task's notes.

Files on a task use `task_file_add`, `task_file_get` and `task_file_remove`,
and `task_get` lists them. `task_file_get` shows an image to the assistant and
gives a text file's words. The API routes are `POST /api/tasks/:id/files` (one
multipart `file`) and `GET` or `DELETE /api/tasks/:id/files/:fileId`. The
task's right is the one rule: read the task to open a file, edit it to add or
remove one. The file work runs as the named system step `task-files`, because
the folder is Mantle's own.

Tasks do not remind you on their own. Reminders come from events, and anything
that should reach you unprompted is a heartbeat: a scheduled agent turn that
can read your tasks and message you.
