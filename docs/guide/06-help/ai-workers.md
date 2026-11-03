---
title: AI workers
---

## AI workers

AI workers are the background jobs that run without a conversation. The extractor pulls facts and entities from new content, the summarizer folds long chats into digests, and others handle voice, vision, documents, images, search and embeddings.

- Workers are grouped by kind. Open one to edit it, or click **Add** beside a kind.
- Set the **Provider**, **API key** and **Model**, and optionally a **Backup route**.
- Turn on **Default** for the one worker of each kind that is actually used.
- Use the test panel on each worker to try it before relying on it.

The **Decider (typed decisions)** writes no text. It makes the brain's small choices, such as which passages fit a question or which context to drop, and answers with a choice, a score or a yes or no. Each use has its own switch and a **Mode**: **Shadow (log only)** records the answer, **Live (act on the answer)** uses it. What it is sent leaves this box, so **Request zero data retention on every call** stays on unless you have a reason.

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
- The decider's privacy is `zdr` (zero data retention: the provider keeps nothing) or `no_training`; the stricter one wins, and a call never retries with less. Its model pool keeps Jev as the default and `perplexity/pplx-decider-v1.2` as the second choice, and refuses models that cannot take its request.
- Tools: `synthesize_speech`, `extract_from_image`, `summarize_text`, `generate_image`.
