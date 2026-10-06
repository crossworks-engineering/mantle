---
title: Email
toolGroups: [email, memory-core]
---

## Email

Email shows the mail Mantle has taken in, by account and folder. It is also part of the brain, so the assistant can answer from it.

- Pick an account and a folder, then switch between **All mail** and **Unread**.
- Click a message to read it in the reading pane.
- Only mail from your contacts and your own addresses is taken in. If the list is empty, use **Add a contact** or **Discover senders**.

There is no compose button. Ask the assistant to send mail.

## Assistant

- "What did Sam say about the delivery date?"
- "Summarise this week's mail from Example Ltd."
- "Reply to Sam confirming Tuesday works."

Ask about the content, not the message. The answer may sit in an attachment.

## Technical

- Mail syncs over IMAP, or through Microsoft when Outlook is connected. Each message is checked against the contacts list before anything is fetched or stored.
- A message is stored as an `email` node with its attachments. Attachment files go to object storage and are read like any other file.
- Mail is sent through your own provider: over SMTP with the app password for an IMAP account, or through Microsoft for an Outlook account. It only goes to contacts.
- Tools: `email_list`, `email_get`, `email_page`, `email_send`.
- Accounts are set up on the [Email accounts](accounts.md) screen.
