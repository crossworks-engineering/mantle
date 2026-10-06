---
title: Secrets
toolGroups: [secrets]
---

## Secrets

Secrets is an encrypted vault for passwords, PINs, licence keys, card details
and other values you should not keep in a note.

1. Press **New secret**.
2. Give it a **Title**, a **Kind** (password, token, server, card, note or
   other), and optional **Tags** and a **Description**.
3. Add the values under **Fields (encrypted)**, each with a label such as
   "username", and an optional **Note (encrypted)**.
4. Press **Save secret**.

Open a secret and press **Reveal** to see its values. Write a good description:
it is what makes a secret findable, because the values are never searched.

## Assistant

- "Save this as a secret: alarm panel PIN, 4417."
- "Do I have a secret saved for the insurance portal?"

The assistant can save a one-value secret and can find a secret by its title,
description and tags. It cannot read the value back to you; open the secret
here for that. Use this screen for secrets with several fields.

## Technical

Values are sealed with AES-256-GCM under the brain's master key
(`MANTLE_MASTER_KEY`), bound to their row so they cannot be moved between rows.
Only the title, description and tags are indexed for search; sealed values are
left out of extraction, embedding and search. A value the assistant saves with
`secret_create` is hidden in trace logs.

Restore a brain without the same master key and every secret stays sealed and
unreadable. Keep a safe copy of the key; see [Backups and
restore](../05-admin/02-backups.md).
