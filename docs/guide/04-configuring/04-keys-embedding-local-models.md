# API keys, embedding & local models

This page covers the model plumbing: the provider keys the system uses, the
embedding model behind meaning-search, and how to run models on your own hardware.

## Settings → API keys

Add keys for the AI providers you want to use. Each key has a **Test** button that
checks it's alive before you rely on it.

The one that covers the most ground is **OpenRouter**: a single OpenRouter key
powers chat (the assistant and all background workers), embeddings, and reading
images/PDFs — the entire text-and-vision brain. You only need *direct* provider
keys for things OpenRouter doesn't proxy:

- **Voice** (speaking replies / transcribing voice notes) → OpenAI, ElevenLabs,
  Deepgram, etc.
- **Image generation** → OpenAI, xAI, Google, Hugging Face.

So a minimal setup is one OpenRouter key; add others only for voice or image
features.

## Settings → Embedding

Embeddings are the numeric "meaning fingerprints" behind semantic search — every
document and query is embedded so the brain can find things by meaning. There's
**one embedding model for the whole system** (it has to be consistent, or stored
and query vectors wouldn't be comparable).

The default is **EmbeddingGemma running locally** (via Ollama): 768-dimensional,
**free**, and **private** — your content's vectors never leave the box. That's the
right default for a self-hosted brain.

The settings page lets you:

- Choose the model and a **primary + backup route** (the backup must be the *same*
  model — different models live in incompatible vector spaces).
- **Test dimensions** — probe the model's output size; the system is locked to
  768, so a model emitting a different size is blocked (it would need a schema
  migration).
- **Rebuild index** — re-embed your whole corpus after a deliberate model change.

> Rule of thumb: **don't switch the embedding model without a measured reason.**
> Most retrieval misses come from what's indexed or how a query is phrased, not the
> model — and switching means re-embedding everything.

## Local models & your own network

You're not tied to the cloud for *chat* either. With **Settings → Local network**
(Tailscale) you can let Mantle reach a model machine on your own network — even a
home GPU box behind your router, from a cloud-hosted Mantle — securely and without
port-forwarding.

- Activate the network connection on the **Local network** page (paste a Tailscale
  key once); a "connect a device" guide walks through joining your other machines.
- Then point an agent or worker at a local model: its route gets a base URL and a
  "reach via the local network" toggle, with your reachable machines offered in a
  dropdown.

Because chat supports **primary/backup failover with different models** (see
[Agents & workers](01-agents-and-workers.md)), the powerful pattern is: run a
**local model as primary** (private, no per-token cost) for the assistant or the
background workers, with a **cloud model as the safety net** for when the local box
is busy or offline. Combined with local embeddings, you can run a genuinely private
brain and only touch the cloud as a fallback.

## A sensible default

1. One **OpenRouter** key → chat + embeddings + document/vision all work.
2. Leave **Embedding** on the local default (free, private, already 768-dim).
3. Add **OpenAI**/**ElevenLabs** only if you want voice; add image-gen providers
   only if you want generated images.
4. Explore **local models** later if privacy or cost makes it worthwhile.
