---
title: AI workers
---

## AI workers

The jobs that run without a conversation. A new document arrives and the
**extractor** pulls out its facts and entities; chat history gets long and the
**summarizer** compresses it; a timer fires and the **reflector** runs. Voice,
vision and image generation live here too.

A worker is not a small agent. It has no persona, no memory of previous runs, no
tool loop and no turns — it's a one-shot transformation triggered by an event.
That's why it's a separate screen: an agent and a worker share about five
settings and disagree about the rest.

Each kind has exactly **one default** at a time. The others can exist, enabled
or not, but the default is what actually gets called.

## Before you change anything

Workers are where your ongoing cost lives. Agents cost money when you talk to
them; workers cost money every time content arrives, forever. A worker pointed
at an expensive model is the usual explanation for a spend graph that climbs
while you weren't using the app.

The failure mode to watch for is silence, not errors. A worker with too small a
context window truncates rather than fails — you get a summary of the first
third of a document and no warning. Check the model's context on the Models
screen before switching a worker to it, especially the extractor.

Workers can hold skills, which teach them how to do their job well. They can
never hold tools. If you're looking for the setting that lets the extractor
write to a table, it doesn't exist by design.

## Technical

Workers are their own table, keyed by kind — reflector, extractor, summarizer,
TTS, STT, vision, image generation, embedding. Each row carries a provider, a
model id, an optional key reference, an optional system prompt and a bag of
kind-specific parameters. One default per kind is enforced in the database with
a partial unique index rather than by convention.

The chat-shaped kinds get the same primary/backup failover the agents do, so a
local extractor can fall back to a cloud model without dropping the ingest.

Media kinds don't call chat models at all — they call dedicated provider
endpoints, which is why their provider list differs from the one you see on an
agent. A provider that's excellent for chat may not appear as an option for
speech at all.

Extraction runs on a fixed set of node types and skips work it has already done:
content is hashed, and unchanged material re-uses its cached result. Re-saving
something unchanged is therefore close to free, which is what makes the whole
eager-extraction design affordable.
