---
title: API access
---

## API access

An API key lets a script or an MCP client use this brain as you. You can give it fewer rights than you have: read only, or only some areas, such as Tasks or Tables.

1. Press **Make key**.
2. Type a name, for example "Backup script".
3. Pick **Read only** or **Read and write**, and when the key expires.
4. Leave **All areas** on, or turn it off and tick the areas the key needs.
5. Type your password and press **Make key**, then copy the key. It is shown once.

The **Search** area searches every kind of item, email and journal included. Tick it only for a key that may read everything.

The list shows each key's rights, when it was last used and when it expires. Press the bin icon to revoke a key. A revoked key stops on its next request.

A plain sign-out does not end a key. A password change, **Sign out everywhere**, a disable or a role change ends all your keys.

This is not **API keys**. That screen holds the keys this brain uses to call other services.

## Assistant

This screen has no assistant tools. Make a key here, then use it from your script or MCP client.

## Technical

- A key works as `Authorization: Bearer mtlk_...` on the public API (`/api/v1`) and on `/api/mcp`. Every other route refuses it.
- Each login makes keys for itself only. An admin also sees and may revoke every key on the brain.
- Only a hash of the key is stored. Each key may make 120 requests a minute on `/api/v1`.
- See [API keys](../07-api/08-api-keys.md) and [The HTTP API](../07-api/03-http-api.md).
