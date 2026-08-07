---
title: API keys
---

## API keys

Where provider credentials live, the OpenRouter, OpenAI, Anthropic, ElevenLabs
and Mapbox keys that everything else points at.

A key is stored **sealed** and shown once. After you save it, this screen can
tell you the provider, the label, when it was last used and whether it still
works, but it cannot show you the key. Neither can the assistant, and neither
can a tool that uses it.

Nothing else in the app stores a credential. An agent, a worker and an HTTP tool
all hold a *reference* to a row here, which is why rotating a key in one place
fixes everything at once.

## Before you change anything

Test before you rely on it. The test button makes a real call to the provider,
so a key that's expired, rate-limited or scoped wrong fails here rather than
silently degrading a background worker at three in the morning.

Rotating replaces the value in place and keeps the same row, so every agent,
worker and tool pointing at it follows automatically. **Deleting** is the one to
be careful with: it doesn't delete the things using it, it just unpins them,
so an agent keeps working until its next call and then fails with no obvious
connection to what you did.

One key usually powers more than you think. The OpenRouter key commonly serves
chat, embeddings and several workers at once, so replacing it with one scoped
more narrowly can break things that never appear on this screen.

## Technical

Values are sealed with the brain's master key before they're written, and are
decrypted only at the moment of a provider call. The row id is bound into the
encryption, so a value cannot be lifted from one row and replayed in another.

HTTP tools reference a key by placeholder rather than embedding it, the tool's
stored templates hold the reference, and substitution happens at call time
inside the dispatcher. That's what makes a tool definition safe to read, share
and let an agent author.

The practical consequence is the same one that applies to Secrets: restore a
brain onto another machine without carrying the same master key, and every key
here is intact but undecryptable. The key is not stored beside the data it
protects. Carry `MANTLE_MASTER_KEY` with any backup you intend to actually
restore from.
