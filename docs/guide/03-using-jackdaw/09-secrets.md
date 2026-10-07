# Secrets

Store passwords, codes and keys in a sealed vault that the assistant can search but never read.

## How a secret is split

| Part | Who can read it |
|---|---|
| **Title**, **Description**, **Tags** | You, search and the assistant. |
| Fields (label and value) and **Note (encrypted)** | Only you, in Jackdaw, after **Reveal**. |

The sealed part is never sent to a model and never indexed. So the assistant can tell you a secret exists and what it is for, but cannot read the value out.

## Add a secret

1. Open **Secrets** and create a secret.
2. Fill in **Title** and pick a **Kind**: password, token, server, card, note or other.
3. Write a **Description** that helps you find it later, without the value. For example: "Pairing code for the gate remote."
4. Click **Add field** for each value, such as `username` and `password`.
5. Add free-form text to **Note (encrypted)** if needed, then save.

## Read a secret

1. Open the secret.
2. Click **Reveal**. Show or copy each field.
3. Click **Hide** when you are done.

## Ask the assistant

- "Do I have anything saved for the insurance portal?"
- "What's the gate code entry for?"
- "Save this as a secret: alarm panel code, 4417."

The last one stores the value sealed. The words you type in chat still pass through the chat model once, so type the most sensitive values on the **Secrets** screen instead.

## If it fails

- **Every secret fails to decrypt after a restore**: the server was restored without its original master key. The key is not stored with the data. See [Backups and restore](../05-admin/02-backups.md).

## Next

- [Apps](10-apps.md)
- Screen help: [Secrets](../06-help/secrets.md)
