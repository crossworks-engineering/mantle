---
title: API keys
---

## API keys

API keys holds the provider keys that agents, workers and tools use, such as OpenRouter, OpenAI, Anthropic, Google, ElevenLabs or a local server.

1. Click **New**.
2. Pick the **Provider**, give a **Label** and paste the **Key value**.
3. Click **Save key**. The key is shown once so you can copy it. After that only a masked form shows.

An Anthropic key made outside an Anthropic workspace needs the **Anthropic workspace id** (optional field, shown for Anthropic keys). Without it every call with that key fails with "This Anthropic key is not tied to a workspace". A key made inside a workspace needs nothing. You can add or clear the id on a saved key without re-entering the key.

Open a key to **Test** it (a no-cost call to the provider), **Rotate** it to a new value, or delete it.

Rotating keeps the same entry, so everything that uses the key follows at once. Deleting is the risky one: agents and workers that used the key are left with no key set. One key often powers chat, embeddings and several workers.

**Kinds of secret.** The vault holds four kinds of secret, each under a **name** that agents say (for example `printer-07`). A key you added before keeps `service` or `service/label` as its name.

| Kind     | Holds                                                        |
| -------- | ------------------------------------------------------------ |
| token    | an API key (every key added before is a token)               |
| password | one password                                                 |
| ssh_key  | an SSH private key, the user it logs in as, and a passphrase |
| login    | a user and a password                                        |

A password, an SSH key or a login also needs a **target**: the hosts (`printer-07.lan`, `192.0.2.12:2222`) or web origins (`https://api.example.com`) it may be used on. **Tags** group secrets (`printers`). **Needs approval** is on by default for a password, an SSH key and a login: each use will wait for you. Agents cannot use these kinds yet; that comes in a later release.

**Write-only.** You can add, replace, test and delete a secret from the Keys screen, from your MCP client (`api_key_set`, `api_key_test`, `api_key_delete`, `api_key_import`) or with a CSV import (`name,kind,target,user,secret,tags`). No screen, tool or API ever shows a value again, to you or to an agent: replace it instead. A test of a token calls its provider; a test of another kind only checks the stored shape. Every add, replace, test and delete is written to the audit log, without the value.

**From an MCP client, a replace or a delete waits for you.** Adding a new key is instant. Replacing a key that exists, or deleting one, goes to Pending approvals: the item shows the key's name, kind, target and masked preview, never the value. It happens only when you approve it in the app (or on its Telegram card); an MCP client cannot approve it, so an agent a web page or a document steered cannot swap your key for its own. A CSV import adds its new keys at once and holds every row that replaces a key for one approval. Rejecting it drops the waiting value. If the key changes in the meantime, the approval does nothing and says so.

## Assistant

The assistant cannot see or change keys. It can list masked key references when it builds a tool. Only your own MCP client has the write tools.

## Technical

- Keys are encrypted with the server's `MANTLE_MASTER_KEY` and only decrypted for a provider call. Each value is bound to its row, so it cannot be copied into another.
- Agents, workers and the embedding setup point at a key by id. HTTP tools use a `{{secret:service/label}}` reference filled in at call time.
- Restore a backup without the same `MANTLE_MASTER_KEY` and every key is unreadable. Keep that key with your backups, stored apart.
- Tools: `api_key_refs` (masked previews only); over MCP only, `api_key_set`, `api_key_test`, `api_key_delete` and `api_key_import`, which go through the one write gateway in `@mantle/api-keys` (`vault.ts`: the keys area check and the audit row).
- A waiting MCP replace or delete is sealed on the key's own row (`held_enc`), bound to the row and to a hold id that the pending item carries instead of the value. Approving it runs the change through the same gateway again, with the keys area checked for the person who asked; any other write to the key first makes it stale.
- Only a token is ever opened to call a provider or fill a `{{secret:...}}` reference. The other kinds are sealed with the row id and their kind, so nothing that opens a token can open them; their fields (user, passphrase, sudo password) are sealed apart. A new value clears the stored passphrase and sudo password unless they are sent again.
- See [Models and API keys](../05-admin/05-models-and-keys.md).
