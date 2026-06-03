# Agents & AI workers

This is where you shape the assistant and the machinery behind it. Two screens:
**Settings → Agents** (the assistants you talk to) and **Settings → AI workers**
(the background jobs that keep the brain fed). First read
[Agents, skills & tools](../02-concepts/02-agents-skills-tools.md) for the concepts.

## Settings → Agents

Each agent is a configured assistant. The common settings:

- **Name & persona** — its identity and voice. The persona also grows on its own as
  the assistant learns your preferences; you can view and edit those learned notes
  here.
- **Model & provider** — which AI model answers. Pick from a searchable catalogue
  showing context window and pricing. Can be a cloud model or a local one.
- **Backup route** — an optional second model the assistant fails over to if the
  primary is down or rate-limited. The backup can be a *different* model (chat has
  no constraint requiring them to match), which is what lets you run a **local model
  as primary with a cloud model as the safety net**, or vice versa. There's a
  "make backup primary" swap when you want to flip them.
- **Voice (TTS)** — which voice this agent speaks with for voice replies. Each agent
  can have its own.
- **Tools** — the allowlist of actions it may take (see
  [Skills & tools](02-skills-and-tools.md)).
- **Skills** — the know-how attached to it.
- **Delegates to** — which specialist agents it's allowed to hand work to.
- **Telegram bot** — paste a bot token here to bind this agent to a Telegram bot
  (this is also where you approve pairing requests). One responder = one bot.
- **Enabled & priority** — turn it on/off; when two agents share a role, the
  higher-priority one wins.

You start with a **responder** (Telegram) and an **assistant** (web). You can add
more, including specialised agents that others delegate to.

### The specialist agents

These ship as delegation targets the front-door assistant can call:

- **Remy** — replays past conversations word-for-word (lossless recall).
- **Researcher** — searches the live web, returns a cited synthesis.
- **Pages** — restructures and reformats long documents safely.
- **Docs** — answers "how does this work?" from indexed documentation.

You rarely configure these directly — they're wired in for you — but they appear in
the Agents list.

## Settings → AI workers

Workers are the one-shot jobs that run automatically — no personality, no
conversation. The important ones:

| Worker | What it does | When it runs |
|---|---|---|
| **Extractor** | Reads each new item → summary, search index, facts, graph links. The engine of memory. | Every time content is added or edited. |
| **Summarizer** | Rolls older conversation into digests so nothing is lost as chats age. | When a conversation grows past a threshold. |
| **Reflector** | Notices durable preferences about you and adds them to the assistant's persona. | Periodically in the background. |
| **Speech-to-text (STT)** | Transcribes inbound voice notes. | On a voice message. |
| **Text-to-speech (TTS)** | Synthesises spoken replies. | When a voice reply is wanted. |
| **Vision / Document** | Describes/OCRs images and reads PDFs (incl. scanned). | When an image or PDF is ingested. |
| **Image generation** | Creates images on request. | When the assistant uses the image tool. |

Each worker has its own model, provider, and key, and supports the same
**primary/backup failover** as agents — so your background indexing can run on a
local model with a cloud fallback. There's one *default* worker per kind; you can
run several and pick which is default.

## Keys & providers

Agents and most workers need a provider key, set under **Settings → API keys**. An
**OpenRouter** key alone covers all chat, embeddings, and document/vision reading.
Voice (TTS/STT) and image generation need a direct provider (e.g. OpenAI,
ElevenLabs). Each key has a **Test** button to confirm it works before you rely on
it.

## Local & cloud models

You're not locked into the cloud. With the **Local network** settings (Tailscale)
and the local model adapters, you can point agents or workers at a model running on
your own hardware — total privacy, no per-token cost — and keep a cloud model as
backup. Embeddings (meaning-based search) already run locally and free by default;
see **Settings → Embedding**.

## A sensible starting setup

1. Add an **OpenRouter** key (covers the brain end to end).
2. Leave the default **responder**, **assistant**, and workers as-is — they're
   pre-configured.
3. Add **OpenAI** (or ElevenLabs) only if you want voice in/out.
4. Tune personas, voices, and models later, once you've used it a bit.

Next: [Skills & tools](02-skills-and-tools.md).
