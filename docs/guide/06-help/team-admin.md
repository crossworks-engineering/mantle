---
title: Team
toolGroups: []
---

## Team

This screen holds the team settings. Members see what the workspaces they
are users of hold, and chat with the Team workspace's assistant.

The tabs:

- **Shared links**: the public links you have given out, to preview or revoke.
- **Settings**: **Member chat** names the Team workspace's assistant, the one
  members chat with (none set: no member chat; set one on the Team
  workspace's page), and **Expose email & journal**, off by default.

Invites and client logins are in [Logins](users.md). Old links to those tabs
open there. The old **Chat archive** tab is gone; the old portal chats stay
in the brain as history.

Review is gone: members no longer submit items for approval, and the
**Requests** tab is gone. A change request the team agent files is a task on
the **Tasks** board. Share items with members with **Grant Access**.

Disable, demote or delete a login in [Logins](users.md) and its access ends at
once. How-to: [Member and client logins](../05-admin/07-logins.md).

## Assistant

- "Which assistant do members chat with?"
- "Is Expose email & journal on?"

Each user's chats are their own: no admin, the brain owner included, reads a
member's chat, and your assistant cannot either. The Team assistant that
answers members is a different agent, and cannot read this view.

## Technical

The Team assistant runs in the Team workspace: it reads what that workspace
holds and answers the member who asked, in that member's own thread. Email
and journal reads stay off until you switch on **Expose email & journal**.
The old member chat routes (`/api/member/chat`, `/api/team-admin/member-chats`)
answer 410: a member's thread is read and written through the assistant
routes, like everyone's.

Every request re-checks the login, so a disabled or deleted login loses access
mid-session. Every route behind this screen and behind the moved parts in
Logins answers admin logins only.
