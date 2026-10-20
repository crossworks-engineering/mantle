---
title: Team Portal
toolGroups: []
---

## Team Portal

The team portal and its team codes are retired. Old codes no longer work,
and the app no longer shows this screen in the menu.

Your team signs in with its own logins:

1. Open **Settings > Logins** and click **Invite**.
2. Make an invite link for an email address.
3. Send the link. The person sets a password and signs in.
4. Add them to the workspaces they need on **Settings > Workspaces**.

Each user chats with the assistant of each workspace they are in, in their
own thread. See [Logins](users.md) and [Add logins](../05-admin/07-logins.md).

## Assistant

- "How do I invite someone to the team?"

Each user's chats are their own: the assistant reads no other user's chat
and no old portal thread.

## Technical

Logins replaced the portal. The old portal threads are kept in
`archive_team_messages` as history; nothing new is written to them, and the
team chat tools that read them are gone. What a login reads comes from its
workspaces (docs/workspaces.md).
