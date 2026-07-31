---
title: Journal
toolGroups: [journal]
---

## Journal

Short, first-person notes about your life — what you did, how it went, how you
felt. Each entry can carry a mood and a life area.

This is the one place in Mantle written for *you* rather than about your work.
It is also the most direct way to teach the assistant who you are: entries are
distilled into a standing description of you that it carries into every
conversation, on every channel.

Write a line a day and the assistant stops being a stranger with access to your
files.

## Assistant

- "Journal: long day on site, the pump job finally closed out. Tired but good."
- "How was I feeling about the Acme project last month?"
- "What have I been writing about most this year?"

Ask it to journal *for* you after a conversation — "note that down as a journal
entry" — and it will write it in your voice rather than summarising you in the
third person.

## Technical

Entries are nodes with a mood and category alongside the body, so they can be
queried by feeling and life area rather than only by text.

The identity block is the interesting part: rather than retrieving journal
entries per question, a distillation of them is assembled into an always-on
"about the user" section prepended to every agent turn. That happens **without
an LLM call** — it is a deterministic roll-up, so it costs nothing per turn and
cannot drift or hallucinate.

Entries are also indexed normally, so a specific question ("what did I say about
the pump job?") still retrieves the actual entry rather than the summary.
