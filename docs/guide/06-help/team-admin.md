---
title: Team
toolGroups: []
---

## Team

The Team screen is retired. Its parts moved:

- **Who reads what**: **Settings > Workspaces**, and each item's **Access**
  panel. See [Workspaces and people](../03-using-jackdaw/12-team.md).
- **Invites**: **Settings > Users**. See [Users](users.md).
- **Shared links**: **Settings > Shared links**, the public links you have
  given out, to preview or revoke.
- **Member chat**: each workspace's screen names its own assistant.

Review, requests and the chat archive are gone. Share items from their
**Access** panel.

## Assistant

- "Which assistant does each workspace have?"
- "How do I share a page with a workspace?"

Each user's chats are their own: no admin, the brain owner included, reads
another user's chat, and your assistant cannot either.

## Technical

An assistant of a workspace other than Admin runs in that workspace: it
reads what that workspace holds and answers the user who asked, in that
user's own thread. A member who names no assistant chats with the one of
their oldest workspace beyond Admin that has one. It never reads mail or
journal entries: those kinds live in the Admin workspace only. The old
member chat routes (`/api/member/chat`, `/api/team-admin/member-chats`) are
gone.

Every request re-checks the login, so a disabled or deleted login loses
access mid-session.
