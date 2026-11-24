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
- "Translate this spec into German and save it."

The **Translator** translates text or an item (a page, a note, a file, an email) into another language. A long text is translated in parts, every part in order, so nothing is left out; if a part cannot be translated the whole request fails and says so, it never hands back a shortened text. With save, it makes a new copy beside the original, for example "Spec (German)": a note stays a note, a page stays a page, anything else becomes a page. It costs nothing until someone asks for a translation: nothing starts it by itself. It runs on its own model, sends a part to its fallback model only when the main model fails that part, and uses its high-quality model only when you ask for careful terminology or style.

## Technical

- Workers live in their own table. Each kind has exactly one default, enforced by the database.
- A worker has no persona, memory or tools. It is a one-shot job started by an event.
- The extractor has extra settings: which node types it reads and a cost cap per node.
- Chat-type workers can fail over to their backup route. Voice, transcription, vision and embedding workers ignore it.
- The decider's privacy is `zdr` (zero data retention: the provider keeps nothing) or `no_training`; the stricter one wins, and a call never retries with less. Its model pool keeps Jev as the default and `perplexity/pplx-decider-v1.2` as the second choice, and refuses models that cannot take its request.
- Tools: `synthesize_speech`, `extract_from_image`, `summarize_text`, `translate`, `generate_image`. Over MCP, an Admin user with the Settings area reads or sets the Translator's models with `translator_settings`.
- **Search languages** (under the Translator): language codes, for example `es`. Supported: Danish, Dutch, English, Finnish, French, German, Hungarian, Italian, Nepali, Norwegian, Portuguese, Russian, Spanish, Swedish and Turkish (the languages with a stop-word list; the field says so when a code is not one). Search by meaning already finds a passage in any language; search by words does not, because the word index reads English. With a code here, every word search also looks for the query's words in that language: the Translator's model translates the query (one short call per new query and language, then kept), never your documents. If the translation is slow or fails, the search runs on your own words, as before. Leave it empty when the brain's documents are in English. Over MCP: `search_languages`.
