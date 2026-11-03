---
title: Team Portal
toolGroups: []
---

## Team Portal

The team portal and its team codes are gone. Old codes no longer work, and
the app has no portal screen.

Your team signs in with its own logins:

- **Invite a person**: **Settings > Users**, then **Invite**. They set a
  password and sign in. See [Add users](../05-admin/07-logins.md).
- **Decide what they read**: add them to workspaces on **Settings >
  Workspaces**. See [Workspaces and people](../03-using-jackdaw/12-team.md).
- **Talk with them**: **Chats**. See [Chats](chats.md).
- **Share with someone outside**: a public link, listed on **Settings >
  Shared links**.

## Assistant

- "How do I invite someone to the team?"

Each user's chats are their own: the assistant reads no other user's chat
and no old portal thread.

## Technical

Logins replaced the portal. The old portal threads are kept in
`archive_team_messages` as history; nothing new is written to them, and the
team chat tools that read them are gone. What a login reads comes from its
workspaces.
