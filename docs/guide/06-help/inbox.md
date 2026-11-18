---
title: Email
toolGroups: [email, memory-core]
service: sync
---

## Email

Email shows the mail the brain already holds, by account and folder. It is also part of the brain, so the assistant can answer from it.

- Pick an account and a folder, then switch between **All mail** and **Unread**.
- Click a message to read it in the reading pane.
- No new mail arrives for now: linking a mailbox moves into the Sync service. The mail already here stays readable and searchable.

There is no compose button, and the assistant sends no mail until sending returns with the Sync service.

## Assistant

- "What did Sam say about the delivery date?"
- "Summarise this week's mail from Example Ltd."

Ask about the content, not the message. The answer may sit in an attachment.

## Technical

- A message is stored as an `email` node with its attachments. Attachment files sit in object storage and are read like any other file.
- When mail sync runs again (the Sync service), each message is checked against the contacts list before anything is stored.
- Tools: `email_list`, `email_get`.
