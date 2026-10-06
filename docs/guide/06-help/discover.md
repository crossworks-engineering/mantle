---
title: Discover senders
toolGroups: [contacts, email]
---

## Discover senders

Discover senders lists people who emailed you in the last 30 days but are not in your contacts. Their mail is not being taken in.

- The screen scans your connected mailboxes when it opens. Use the refresh button to scan again.
- Each row shows the sender, their address, how many messages and the latest date.
- Click **Add as contact** for anyone worth keeping. Mantle then pulls in the last 90 days of their mail.

If no email account is connected, the screen offers **Connect an account**.

## Assistant

The assistant cannot run this scan. Once you know a sender, it can add them:

- "Add orders@example.com to my contacts as Example Ltd."
- "Add Sam from Example Ltd, sam@example.com, as a contact."

## Technical

- The scan reads message headers from every enabled account live. It stores nothing.
- Adding a sender creates a normal contact with that one address. That same list also lets the assistant send mail to them.
- Tools for the follow-up: `contact_create`, `contact_update`.
- See [Contacts](contacts.md) for how the email gate works.
