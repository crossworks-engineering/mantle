---
title: Secrets
toolGroups: [secrets]
---

## Secrets

An encrypted vault for passwords, codes, licence keys and account numbers,
the things you need to look up occasionally and shouldn't keep in a note.

Each secret has a name and description you can search, and a value that stays
sealed. The description is the part that makes it findable: "the gate remote's
pairing code" is worth writing even though the code itself is hidden.

## Assistant

- "What's the wifi password for the office?"
- "Save this as a secret: alarm panel code, 4417."
- "Do I have anything saved for the insurance portal?"

The assistant can search names and descriptions and tell you a secret *exists*,
but it never sees the value, so it can point you at the right entry and cannot
read it out. That is deliberate, and it is the reason secrets are safe to keep
in a system that talks to language models.

## Technical

Values are sealed with AES-256-GCM using the brain's master key, with the row id
as additional authenticated data, so a value cannot be moved between rows, and
a wrong or missing `MANTLE_MASTER_KEY` fails loudly rather than returning
plausible rubbish.

Only the name, description and tags are indexed into the brain; the sealed value
is excluded from extraction, embedding and search. That is why the assistant can
reason about which secret you want without ever holding the secret.

The practical consequence: restoring a brain to another machine without carrying
the same master key leaves every secret undecryptable. The data is intact, but
unreadable; the key is not stored alongside it.
