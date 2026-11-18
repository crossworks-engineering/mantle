---
title: Email
toolGroups: [email, memory-core]
service: sync
---

## Email

Email shows the mail the brain already holds, by account and folder. It is also part of the brain, so the assistant can answer from it.

- Pick an account and a folder, then switch between **All mail** and **Unread**.
- Click a message to read it in the reading pane.
- Link a mailbox in **Settings > Sync**. New mail from your contacts arrives every 5 minutes.

There is no compose button: ask the assistant to send a message, or to email a page.

## Assistant

- "What did Sam say about the delivery date?"
- "Summarise this week's mail from Example Ltd."
- "Email Sam the meeting notes page."

Ask about the content, not the message. The answer may sit in an attachment.

## Technical

- A message is stored as an `email` node with its attachments. Attachment files sit in object storage and are read like any other file.
- The Sync service reads the mailbox; each message is checked against the contacts list before anything is fetched or stored.
- Sending goes through the mailbox's own SMTP server, to contacts only, and waits for your approval by default.
- Tools: `email_list`, `email_get`, `email_send`, `email_page`.
