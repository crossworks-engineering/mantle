---
title: Worker groups
---

## Worker groups

A worker group is a named set of worker agents that a background run can ask
as a panel. A run step aimed at a group gets one separate attempt from each
member, then a review step reads all the attempts and judges them. Where the
members agree, the result is easier to trust.

Groups only matter inside [runs](runs.md). They change nothing in ordinary
chat.

1. Press **New**, enter a **Name** and a **Slug**, and press **Create worker group**.
2. Under **Members (enabled worker agents)**, tick the workers to include.
3. Press **Save worker group**.

Every member is a full model call on every step aimed at the group, so a
group of five costs five times one worker, plus the review. Two or three
members is usually enough. Members on the same model with the same prompt
give the same opinion three times; vary the model or the prompt. Only enabled
workers can be members.

## Assistant

Agents in Jackdaw have no tools for this screen. An MCP client signed in as
you can manage groups when you ask:

- "List my worker groups."
- "Make a review panel group with the two drafting workers."

It uses `worker_group_list` and `worker_group_ensure`.

## Technical

Groups are stored in `agent_groups`. A group step is expanded when the run is
planned: one parallel attempt per member, then a panel review step. The
review sees every attempt in full. A `pass` verdict means at least one attempt
is usable, and the review's directive is the result later steps read. A
blocking verdict asks you instead of retrying, and a panel never reruns on
its own.
