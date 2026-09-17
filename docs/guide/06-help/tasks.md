---
title: Tasks
toolGroups: [tasks]
---

## Tasks

Things you need to do, with a status, a priority and an optional due date.

Deliberately plain. This isn't a project-management system; it's the list the
assistant can read and add to while you're talking to it, so a commitment made
mid-conversation doesn't evaporate.

## Assistant

- "Add a task: order the replacement seal, high priority, due Friday."
- "What's overdue?"
- "Mark the seal task done."

The useful habit is letting tasks come out of conversation rather than typing
them here. If you say "I must remember to chase the invoice", ask it to make
that a task and it will.

## Technical

A task is a node with typed status, priority and `dueAt` fields, indexed like
everything else, so "what's outstanding for Acme?" can match on the task text
*and* on the entities extracted from it.

Nothing here polls or notifies on its own. Reminders come from **events**, and
anything that should reach you unprompted is a **heartbeat**: a scheduled agent
turn that can read your tasks and message you. Tasks themselves are just state.
