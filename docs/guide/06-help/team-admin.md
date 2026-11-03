---
title: Team
toolGroups: []
---

## Team

The Team screen is gone. Each of its jobs now has its own place:

- **Talking with people**: **Chats**. Direct chats and groups between the
  people of the brain, and each person's own thread with an assistant. See
  [Chats](chats.md).
- **Who reads what**: **Settings > Workspaces**, and each item's **Access**
  panel. See [Workspaces and people](../03-using-jackdaw/12-team.md).
- **A workspace's assistant**: the **Assistant** section of that workspace on
  **Settings > Workspaces**.
- **Read posture**, the member setting: the end of the Admin workspace's
  screen on **Settings > Workspaces**.
- **Shared links**: **Settings > Shared links**, the public links you have
  given out, to preview or revoke.
- **Invites and logins**: **Settings > Users**. See [Users](users.md).

## Assistant

- "Which assistant does each workspace have?"
- "How do I share a page with a workspace?"

Each user's chats are their own: no admin, the brain owner included, reads
another user's chat, and your assistant cannot either.

## Technical

The client no longer has a `/team-admin` screen. The old member chat routes
(`/api/member/chat`, `/api/team-admin/member-chats`) are gone. An assistant
of a workspace other than Admin runs in that workspace and answers each user
in their own thread.
