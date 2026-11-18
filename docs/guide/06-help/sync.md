---
title: Mail and calendar accounts
toolGroups: [email, contacts]
service: sync
---

## Mail and calendar accounts

This screen links your mailboxes and calendar feeds to the brain. It comes from the Sync service, so it shows only while an admin has Sync on (Settings > Services).

- **Add a mailbox**: your email address, an app password from your mail provider (not your account password), and the IMAP server. Add the SMTP server too if the assistant may send from this mailbox. **Check and save** logs in once before it saves.
- **Folders**: tick the folders that sync. Trash, Junk and Drafts are left out by default.
- **Add a calendar feed**: a name and the calendar's iCal address. Its events show in Calendar.
- **Sync now** runs a mailbox or a feed at once. Mail syncs every 5 minutes, feeds every 30 minutes.
- **Find senders** lists recent senders who are not contacts yet. **Add as contact** brings in their last 90 days of mail.
- **Remove** stops the sync and deletes the password. Mail already stored stays. A removed feed takes its events with it.

## Assistant

- "Email Sam the quote." (from a linked mailbox, to a contact)
- "What's on my calendar on Friday?"

## Technical

- Only mail from contacts is kept. Mail from anyone else is never fetched.
- Passwords and feed addresses are sealed in the brain with the box's master key. The Sync service keeps nothing on disk.
- Turning Sync off stops it. Nothing is deleted, and on again goes on where it stopped.
