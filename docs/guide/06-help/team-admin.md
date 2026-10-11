---
title: Team
toolGroups: []
---

## Team

This screen handles what members send you, and the team settings. Members
chat with the team agent and see items set to Team level.

The tabs:

- **Shared links**: the public links you have given out, to preview or revoke.
- **Settings**: **Member chat** (members can chat only after you click **Let
  members chat**: it moves the team agent to Team level), and **Expose email &
  journal**, off by default.

Invites, each member's chat and client logins are in [Logins](users.md). Old links to those tabs open there. The old
**Chat archive** tab is gone; the old portal chats stay in the brain.

Review is gone: members no longer submit items for approval, and the
**Requests** tab is gone. A change request the team agent files is a task on
the **Tasks** board. Share items with members with **Grant Access**.

Disable, demote or delete a login in [Logins](users.md) and its access ends at
once. How-to: [Member and client logins](../05-admin/07-logins.md).

## Assistant

- "What has the team been asking about this week?"
- "Has anyone raised anything about the pump job?"

Your assistant can read member chats, the old portal chats and the access log.
The team agent that answers members is a different agent with a much smaller
grant, and cannot read this view.

## Technical

The team agent is read-only except for one write: filing a change request as
a task on your Tasks board, stamped with who asked. It has no sending, delegation,
shell or bulk export. What it can read is capped by its access level, so a
member never reaches items above Team level. Email and journal reads stay off
until you switch on **Expose email & journal**.

Every request re-checks the login, so a disabled or deleted login loses access
mid-session. Your assistant reads the team chats with `team_chat_list`,
`team_chat_read` and `team_access_list`. Every route behind this screen and
behind the moved parts in Logins answers admin logins only.
