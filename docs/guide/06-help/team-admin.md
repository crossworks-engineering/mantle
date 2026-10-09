---
title: Team
toolGroups: [team-admin]
---

## Team

This screen handles what members and clients send you, and the team settings.
Members chat with the team agent and see items set to Team level. Clients see
items set to Client level.

The tabs:

- **Review**: items members submitted for review. The screen opens here.
- **Requests**: change requests filed through the team agent.
- **Shared links**: the public links you have given out, to preview or revoke.
- **Settings**: **Member chat** (members can chat only after you click **Let
  members chat**: it moves the team agent to Team level), and **Expose email &
  journal**, off by default.

Invites, each member's and client's chat, client logins and **What clients
see** are in [Logins](users.md). Old links to those tabs open there. The old
**Chat archive** tab is gone; the old portal chats stay in the brain.

Disable, demote or delete a login in [Logins](users.md) and its access ends at
once. How-to: [Member and client logins](../05-admin/07-logins.md).

## Assistant

- "What has the team been asking about this week?"
- "Has anyone raised anything about the pump job?"

Your assistant can read member chats, the old portal chats and the access log.
The team agent that answers members is a different agent with a much smaller
grant, and cannot read this view.

## Technical

The team agent is read-only except for one write: filing a change request into
your Requests queue, stamped with who asked. It has no sending, delegation,
shell or bulk export. What it can read is capped by its access level, so a
member never reaches items above Team level. Email and journal reads stay off
until you switch on **Expose email & journal**.

Every request re-checks the login, so a disabled or deleted login loses access
mid-session. Your assistant reads the team chats with `team_chat_list`,
`team_chat_read` and `team_access_list`. Every route behind this screen and
behind the moved parts in Logins answers admin logins only.
