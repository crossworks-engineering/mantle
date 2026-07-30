---
title: Email
toolGroups: [email, memory-core]
---

## Email

Your ingested mail, organised by account and folder — readable here, and
searchable as part of the brain rather than as a separate silo.

Only mail from **contacts** is ingested. That's the gate: adding someone to
Contacts starts their mail flowing in, removing them stops it. Attachments come
in too and are read, so a PDF quote is searchable by its contents.

Sending goes out through your own mailbox, to contacts only.

## Assistant

- "What did Sam say about the delivery date?"
- "Summarise this week's mail from Acme."
- "Reply to Sam confirming Tuesday works."

Ask about *content*, not about your inbox — "what was quoted for the roof?" is a
better question than "find the email from Sam", because the answer may be in an
attachment rather than the message body.

## Technical

Mail arrives over IMAP on a sync worker, filtered against the contacts allowlist
before anything is written. Bodies are chunked and embedded like any other
content; attachments are extracted by type (documents through the text pipeline,
images and scans through a vision model) and indexed as their own file nodes.

Threads are reconstructed and stored as `email_thread` nodes so a conversation
retrieves as a unit rather than as scattered messages.

Sending uses your provider's **SMTP submission** with the same app password the
IMAP account already holds — Mantle never runs a mail server and never relays on
port 25, which would land in spam and is blocked on most hosts anyway.

Attachment bytes are the one thing not on the ordinary files disk: they live in
object storage keyed by content hash, which is why they survive a files-root
change that would break disk-backed uploads.
