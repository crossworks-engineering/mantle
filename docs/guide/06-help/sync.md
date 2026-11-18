---
title: Accounts
toolGroups: [email, contacts]
service: sync
---

## Accounts

This screen links your mailboxes, calendar feeds and Microsoft 365 accounts to the brain. It comes from the Sync service, so it shows only while an admin has Sync on (Settings > Services).

- **Add a mailbox**: your email address, an app password from your mail provider (not your account password), and the IMAP server. Add the SMTP server too if the assistant may send from this mailbox. **Check and save** logs in once before it saves.
- **Folders**: tick the folders that sync. Trash, Junk and Drafts are left out by default.
- **Add a calendar feed**: a name and the calendar's iCal address. Its events show in Calendar.
- **Sync now** runs a mailbox or a feed at once. Mail syncs every 5 minutes, feeds every 30 minutes.
- **Find senders** lists recent senders who are not contacts yet. **Add as contact** brings in their last 90 days of mail.
- **Remove** stops the sync and deletes the password. Mail already stored stays. A removed feed takes its events with it.
- **Microsoft app**: an admin registers a web app in Microsoft Entra once and enters its client ID, secret, tenant and redirect URI here. The screen shows the redirect URI to register.
- **Connect a Microsoft account** opens Microsoft's sign-in in a new tab. Sign in, then come back: the account shows with its OneDrive and the libraries of the SharePoint sites you follow.
- **Turn on** a drive to sync it. Its files land in the brain as normal files every 5 minutes, under Microsoft in the files tree. **Choose folders** limits it to the folders or files you tick. A file that leaves the drive, or your choice, leaves the brain at the next sync.
- **Mail on** brings in Outlook mail from your contacts, as for a mailbox. The assistant can then send from that account too.
- **Disconnect** stops the sync and deletes the account's tokens. Every synced file and stored mail stays.

## Assistant

- "Email Sam the quote." (from a linked mailbox, to a contact)
- "What's on my calendar on Friday?"

## Technical

- Only mail from contacts is kept. Mail from anyone else is never fetched.
- Passwords, feed addresses and Microsoft tokens are sealed in the brain with the box's master key. The Sync service keeps nothing on disk.
- A synced file over 64 MB is skipped.
- An admin's own agent can do all of this over MCP (the `sync_*` tools), except signing in to Microsoft.
- Turning Sync off stops it. Nothing is deleted, and on again goes on where it stopped.
