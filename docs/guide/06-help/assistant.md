---
title: Assistant
toolGroups: [memory-core]
---

## Assistant

Where you talk to the brain. Type, or dictate; attach an image or a document and
ask about it; get replies with real formatting rather than a wall of text.

The assistant isn't a chatbot bolted onto your files — it answers **from your
own content**. Everything you've put into Mantle is what it draws on, and when
it doesn't know something it can go and look rather than guess.

The same assistant is reachable on Telegram, and it's the same conversation:
what you discussed on your phone this morning is there when you open this screen
this afternoon.

## How to ask

Talk to it the way you'd talk to someone who works with you and has read
everything — because that's the situation.

- Ask about your own material: "what did we agree with the supplier about
  delivery?" beats "search for supplier".
- Ask it to *do* things, not just find them: "log this expense", "save that as
  a page", "remind me on Friday".
- Follow-ups work. "And the one before that?" keeps the thread; you don't have
  to restate the question.
- It can hand work to specialists — a researcher for the web, a recall agent for
  old conversations, a data specialist for grids — without you naming them.

If it can't do something, that's usually a **grant**, not a limitation: its
tools come from tool groups you control, so an ability it's missing can be
turned on.

## Technical

Each turn is assembled, not merely forwarded. Before the model sees your
message, the runtime gathers: the recent conversation (replayed by count and by
age), rollups of older exchanges, facts extracted from your content matched
against what you just asked, passages retrieved from the index, and an
always-on block describing who you are, built from your journal entries.

Retrieval is vector search over locally-computed embeddings — the passages are
found by meaning, not keyword, which is why a question that shares no words with
a document still finds it.

The conversation is one store per agent across every channel, so Telegram and
the web are literally the same thread rather than two that get reconciled. Older
turns are periodically folded into digests by a summarizer, which is how a long
history stays affordable to carry.

Tools are granted through **tool groups** rather than one by one, and what the
assistant can reach is exactly the union of the groups its agent holds. The
model chooses which to call; the runtime enforces what's allowed, and anything
you've marked as needing confirmation waits for you in Pending.

The chat model itself is configurable per agent, with an optional backup route
that takes over if the primary is unreachable — including a local model with a
cloud fallback, or the reverse.
