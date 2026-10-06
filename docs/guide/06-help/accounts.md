---
title: Email accounts
toolGroups: [email]
---

## Email accounts

Email accounts connects your mailboxes and sets which folders Mantle reads.

1. Click **Add**, then fill in the IMAP form.
2. Enter the **Email address**, **IMAP host**, **Port** (993 for TLS) and an **App password**.
3. Optionally fill in the **SMTP host** and port so the assistant can send from this account. Leave it blank and the account only receives.
4. Set **Scan history (days)**: how far back the first scan reaches (365 by default).
5. Click **Test connection**, then **Connect & save**.

Open an account to see its sync status. Click **Configure folders** to choose which folders to scan. Microsoft accounts also show here and are managed on the Microsoft screen.

Only mail from your contacts and your own addresses is taken in. A new account with no contacts brings in nothing.

## Assistant

- "Did anything come in from the supplier today?"
- "Email Sam the revised quote."

Mail is sent from your own address through your provider. Mantle runs no mail server.

## Technical

- The app password is encrypted at rest and only decrypted to open a connection. Use an app-specific password where your provider offers one, so you can revoke it there.
- Sync keeps a cursor per folder, so a restart picks up where it stopped. A newly added folder scans back by the scan history setting.
- If mail from someone is missing, check [Contacts](contacts.md) first. That is the usual cause.
- Tools: `email_list`, `email_get`, `email_page`, `email_send`. Sending asks for your confirmation.
