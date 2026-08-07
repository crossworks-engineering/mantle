---
title: Microsoft
toolGroups: [files]
---

## Microsoft

Connects Microsoft 365 (SharePoint, OneDrive and Outlook) so documents kept
there are reachable without downloading them by hand.

This is the one connection with a genuine prerequisite: it needs an **Azure app
registration** of your own. Mantle doesn't ship a shared client id, because a
shared one would mean every install's access flowed through somebody else's
application. You register an app, paste its details here, and then connect
accounts against it.

Once connected, each account exposes its drives, and you choose which to sync.

## Assistant

- "Find the signed contract from the SharePoint drive."
- "What's in the tender folder?"

Documents pulled in become ordinary files in your brain, searchable, citable,
readable by the assistant like anything else you uploaded. The point of the
connection is that they arrive without a manual download step, not that they
behave differently once here.

## Technical

Authentication is OAuth, so Mantle holds a refresh token rather than your
password, and access can be revoked from the Microsoft side independently of
anything here. The token is sealed with the brain's master key like every other
credential.

The OAuth start and callback are plain server routes that redirect to Microsoft
, which is why this screen briefly leaves the app during connection, and why the
result comes back as a banner rather than an inline response.

Drives are selected per account rather than per connection. A user with access
to a dozen SharePoint sites doesn't index a dozen sites by default; nothing syncs
until you pick it. Files then flow through the same ingest pipeline as an
upload: extracted, summarised, embedded, indexed.

Mail through this connection is subject to the same contacts allowlist as IMAP.
Connecting Outlook doesn't widen what gets stored.
