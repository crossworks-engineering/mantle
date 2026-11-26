---
title: Secrets
toolGroups: [secrets]
---

## Secrets

Secrets is an encrypted vault for passwords, PINs, licence keys, card details
and other values you should not keep in a note.

1. Press **New**.
2. Give it a **Title**, a **Kind** (password, token, server, card, env, note
   or other), and optional **Tags** and a **Description**.
3. Add the values under **Fields (encrypted)**, each with a label such as
   "username". **Add field** adds another. Add an optional **Note (encrypted)**.
4. Press **Save secret**.

Open a secret and press **Reveal** to see its values. Write a good description:
it is what makes a secret findable, because the values are never searched.

To share a secret with your team, open it and use **Access**, as for a note.
Each user of a workspace it is shared with can reveal it. With **Writable** on,
they can also change it. Paste a whole `.env` file into the note, kind **env**.
Every reveal is logged with who and when, so you know what to change when
someone leaves. A secret never gets a public link and never goes to a linked
brain.

## Assistant

- "Save this as a secret: alarm panel PIN, 4417."
- "Do I have a secret saved for the insurance portal?"

The assistant can save a one-value secret and can find a secret by its title,
description and tags. It cannot read the value back to you, and no app can
either; open the secret here for that. Use this screen for secrets with several fields.

## Technical

A secret is a workspace item: its home and grants say who reads it, and a
user who reads it may reveal it. Each reveal is written to the audit log
(`secret.reveal`) before the value is sent. Values are sealed with AES-256-GCM
under the brain's master key
(`MANTLE_MASTER_KEY`), bound to their row so they cannot be moved between rows.
Only the title, description and tags are indexed for search; sealed values are
left out of extraction, embedding and search. A value the assistant saves with
`secret_create` is hidden in trace logs.

Restore a brain without the same master key and every secret stays sealed and
unreadable. Keep a safe copy of the key; see [Backups and
restore](../05-admin/02-backups.md).
