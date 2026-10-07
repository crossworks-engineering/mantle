---
title: AI workers
---

## AI workers

AI workers are the background jobs that run without a conversation. The extractor pulls facts and entities from new content, the summarizer folds long chats into digests, and others handle voice, vision, documents, images, search and embeddings.

- Workers are grouped by kind. Open one to edit it, or add another.
- Set the **Provider**, **API key** and **Model**, and optionally a backup route.
- Turn on **Default** for the one worker of each kind that is actually used.
- Use the test panel on each worker to try it before relying on it.

The extractor runs on every piece of content that arrives, so workers are where steady cost comes from. Check a model's price and context window on the Models screen before you switch a worker to it.

## Assistant

The assistant cannot change workers. Set them here. Agents that hold the Media workers tool group can call some workers directly:

- "Read the text in this photo."
- "Make an image of a red barn at sunset."

## Technical

- Workers live in their own table. Each kind has exactly one default, enforced by the database.
- A worker has no persona, memory or tools. It is a one-shot job started by an event.
- The extractor has extra settings: which node types it reads and a cost cap per node.
- Chat-type workers can fail over to their backup route. Voice, transcription, vision and embedding workers ignore it.
- Tools: `synthesize_speech`, `extract_from_image`, `summarize_text`, `generate_image`.
