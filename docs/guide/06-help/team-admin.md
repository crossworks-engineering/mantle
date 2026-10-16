---
title: Team
toolGroups: []
---

## Team

This screen holds the team settings. Who reads what is set on
**Settings > Workspaces** and in each item's **Grant Access** panel, not
here.

The tabs:

- **Shared links**: the public links you have given out, to preview or
  revoke.
- **Settings**: **Expose email & journal**, off by default, now at the end
  of the Admin workspace's screen. It has no effect any more: an assistant
  of a workspace other than Admin reads only what its workspace holds, and
  mail and journal entries live in the Admin workspace only. Each
  workspace's screen names its own assistant (the Member chat line went
  with the built-in Team workspace).

Invites are in [Logins](users.md). Old links to those tabs open there.
Review, requests and the chat archive are gone. Share items with
**Grant Access**.

Remove a user from a workspace on **Settings > Workspaces**, or disable a
login in [Logins](users.md), and its access ends at once. How-to:
[Add logins](../05-admin/07-logins.md).

## Assistant

- "Which assistant does each workspace have?"
- "Is Expose email & journal on?"

Each user's chats are their own: no admin, the brain owner included, reads
another user's chat, and your assistant cannot either.

## Technical

An assistant of a workspace other than Admin runs in that workspace: it
reads what that workspace holds and answers the user who asked, in that
user's own thread. A member who names no assistant chats with the one of
their oldest workspace beyond Admin that has one. It never
reads mail or journal entries, whatever **Expose email & journal** says:
those kinds live in the Admin workspace only. The old member chat routes
(`/api/member/chat`, `/api/team-admin/member-chats`) are gone.

Every request re-checks the login, so a disabled or deleted login loses
access mid-session. The routes behind this screen need a user of the Admin
workspace with the users area.
