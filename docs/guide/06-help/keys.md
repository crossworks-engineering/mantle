---
title: API keys
---

## API keys

API keys holds the provider keys that agents, workers and tools use, such as OpenRouter, OpenAI, Anthropic, Google, ElevenLabs or a local server.

1. Click **New**.
2. Pick the **Provider**, give a **Label** and paste the **Key value**.
3. Click **Save key**. The key is shown once so you can copy it. After that only a masked form shows.

Open a key to **Test** it (a no-cost call to the provider), **Rotate** it to a new value, or delete it.

Rotating keeps the same entry, so everything that uses the key follows at once. Deleting is the risky one: agents and workers that used the key are left with no key set. One key often powers chat, embeddings and several workers.

## Assistant

The assistant cannot see or change keys. It can list masked key references when it builds a tool.

## Technical

- Keys are encrypted with the server's `MANTLE_MASTER_KEY` and only decrypted for a provider call. Each value is bound to its row, so it cannot be copied into another.
- Agents, workers and the embedding setup point at a key by id. HTTP tools use a `{{secret:service/label}}` reference filled in at call time.
- Restore a backup without the same `MANTLE_MASTER_KEY` and every key is unreadable. Keep that key with your backups, stored apart.
- Tool: `api_key_refs` (masked previews only).
- See [Models and API keys](../05-admin/05-models-and-keys.md).
