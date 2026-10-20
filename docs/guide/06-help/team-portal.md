---
title: Team Portal
toolGroups: []
---

## Team Portal

The team portal and its team codes are retired. Old codes no longer work,
and the app no longer shows this screen in the menu.

Your team signs in with its own logins, and workspaces decide what each
person reads:

1. Open **Settings > Users** and click **Invite**.
2. Make an invite link for an email address.
3. Send the link. The person sets a password and signs in.
4. Add them to the workspaces they need on **Settings > Workspaces**.

See [Workspaces and people](../03-using-jackdaw/12-team.md) and
[Add users](../05-admin/07-logins.md).

## Assistant

- "How do I invite someone to the team?"

Each user's chats are their own: the assistant reads no other user's chat
and no old portal thread.

## Technical

Logins replaced the portal. The old portal threads are kept in
`archive_team_messages` as history; nothing new is written to them, and the
team chat tools that read them are gone. What a login reads comes from its
workspaces (docs/workspaces.md).
