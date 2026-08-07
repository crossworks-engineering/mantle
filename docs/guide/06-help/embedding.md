---
title: Embedding
---

## Embedding

The model that turns your content into vectors; the thing that makes "find me
that note about the pump" work when you never wrote the word "pump".

There is exactly **one** embedding configuration for the whole brain, and that
is deliberate. Everything indexed has to live in the same vector space to be
comparable; two models mean two spaces, and a search across both is meaningless.

For the same reason this is the one place where primary and backup must be the
**same model**. Elsewhere in Mantle a backup on a different model is a sensible
safety net. Here it would quietly poison the index, because the fallback's
vectors wouldn't sit anywhere near the primary's.

## Before you change anything

Don't switch without a reason. Changing the model means re-embedding the entire
corpus, and while that runs your search results are drawn from a mixed space,
degraded, not broken, but noticeably worse until it finishes.

Good reasons exist. Heavily multilingual content is the main one; a model
trained for cross-language matching genuinely finds things an English-first
model misses. Wanting no cloud calls at all is another; a local embedder keeps
the corpus entirely on your hardware.

The dimension is the hard constraint. Every vector column in the database is
768-dimensional, so a model with a different native size must be reduced to 768
or it cannot be stored at all. Models that support that reduction cleanly are
the ones offered.

## Technical

Embeddings are cached by a hash of the model plus the text, which is what makes
re-indexing cheap: change one paragraph in a long document and only that
paragraph is re-embedded. It's also why switching models is expensive, a new
model invalidates every cache entry at once.

Semantic search is only half of retrieval. Full-text search runs alongside it,
because embeddings are bad at exactly the thing FTS is good at: matching a
literal string. An invoice number or a part code is found by text search, not by
meaning, and the system uses both.

The local option runs the model on your own hardware and needs no key, which is
also the pre-onboarding fallback so a fresh install boots without credentials.
Semantic search stays off until the configuration is completed one way or the
other; the corpus is stored, just not yet findable by meaning.

If retrieval quality is what you're actually worried about, the scheduled recall
evaluation scores it against a fixed question set, so a change here can be
measured rather than guessed at.
