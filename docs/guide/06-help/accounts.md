---
title: Email accounts
toolGroups: [email]
---

## Email accounts

The mailboxes Mantle connects to over IMAP, and which folders it watches.

Connecting an account does **not** start ingesting your mail. The contacts list
is the gate: only messages from addresses you've saved as contacts are ever
stored in the brain. An account with no matching contacts syncs nothing, which
is the intended starting position rather than a misconfiguration.

The folder tree is live — it's read from the server, so you're picking real
folders rather than typing names and hoping. Watching everything is rarely what
you want; the inbox and anything you file deliberately usually is.

## Assistant

- "Did anything come in from the supplier today?"
- "Email Sam the revised quote."

The same credentials do both jobs. Sending reuses the account's app password
over the provider's SMTP — Mantle runs no mail server of its own, so mail leaves
from your address, through your provider, exactly as if you'd sent it.

## Technical

Credentials are sealed with the brain's master key and decrypted only when a
connection is opened. Use an app-specific password where your provider offers
one; it can be revoked from the provider's side without touching your main
account password.

Ingest checks the sender against the contacts allowlist **before** anything is
written, so non-contact mail is never stored in the brain even transiently.
That's what makes the contacts list a genuine privacy control rather than a
display filter — removing a contact stops collection, it doesn't just hide
results.

Sync is incremental and tracks its position per folder, so a restart resumes
rather than re-reading the mailbox. A folder added later starts from its current
state; it does not retroactively pull that folder's history.

If mail from someone isn't arriving, check the contacts list before suspecting
this screen. That's the cause far more often than a broken connection, and the
symptom is identical.
