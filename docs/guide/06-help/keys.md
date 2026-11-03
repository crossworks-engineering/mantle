---
title: API keys
---

## API keys

API keys holds the provider keys that agents, workers and tools use, such as OpenRouter, OpenAI, Anthropic, Google, ElevenLabs or a local server.

1. Click **New**.
2. Pick the **Provider**, give a **Label** and paste the **Key value**.
3. Click **Save key**. The key is shown once so you can copy it. After that only a masked form shows.

An Anthropic key made outside an Anthropic workspace needs the **Anthropic workspace id**. Without it every call with that key fails. You can add or clear the id on a saved key without re-entering the key.

Open a key to **Test** it (a no-cost call to the provider), **Rotate** it to a new value, or delete it. Rotating keeps the same entry, so everything that uses the key follows at once. Deleting leaves the agents and workers that used the key with no key set. One key often powers chat, embeddings and several workers.

**Kinds of secret.** The vault holds four kinds, each under a name that agents say (for example `printer-07`). A key added before keeps `service` or `service/label` as its name.

| Kind       | Holds                                         |
| ---------- | --------------------------------------------- |
| `token`    | an API key (every older key is a token)       |
| `password` | one password                                  |
| `ssh_key`  | an SSH private key, its user and a passphrase |
| `login`    | a user and a password                         |

A password, an SSH key or a login also has a target: the hosts or web origins it may be used on. Tags group secrets (`printers`). The approval switch is on by default for these three kinds, so each use waits for you. The tailnet flag says the target sits on a private network reached through your tailnet. Agents cannot use these kinds yet; that comes in a later release.

**Write-only.** You can add, replace, test and delete a secret here, from your MCP client, or with a CSV import (columns `name,kind,target,user,secret,tags`). Nothing ever shows a value again, to you or to an agent: replace it instead. Every write goes to the audit log, without the value.

**From an MCP client, a replace or a delete waits for you.** Adding a new key is instant. Replacing or deleting one goes to Pending approvals, which shows the key's name, kind, target and masked preview, never the value. It happens only when you approve it in the app or on its Telegram card. An MCP client cannot approve it, so an agent that a web page steered cannot swap your key for its own. An MCP import adds new keys at once and holds every row that replaces a key for one approval.

## Assistant

The assistant cannot see or change keys. It can list masked key references when it builds a tool. Only your own MCP client has the write tools.

## Technical

- Keys are encrypted with the server's `MANTLE_MASTER_KEY` and only decrypted for a provider call. Each value is bound to its row.
- Restore a backup without the same `MANTLE_MASTER_KEY` and every key is unreadable. Keep that key with your backups, stored apart.
- Agents, workers and the embedding setup point at a key by id. HTTP tools use a `{{secret:service/label}}` reference filled in at call time.
- Only a token is ever opened. The other kinds stay sealed with their row id and kind.
- Over MCP, a token named for a service that already has a key (`anthropic` beside `anthropic/work`) waits like a replace. A change that widens a key (a new target or tag, approval off, the tailnet flag moved) must send the value again.
- CSV import: `POST /api/keys/import` with `{ "csv": "..." }`. A bad row writes nothing.
- Tools: `api_key_refs` (masked previews only); over MCP only, `api_key_set`, `api_key_test`, `api_key_delete` and `api_key_import`, all through the one write gateway in `@mantle/api-keys`.
- See [Models and API keys](../05-admin/05-models-and-keys.md).
