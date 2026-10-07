---
title: Team
toolGroups: [team-admin]
---

## Team

This screen manages the people who sign in to your brain as members or
clients, and what they see. Members chat with the team agent and see items set
to Team level. Clients see items set to Client level.

The tabs:

- **Invites**: make an invite link for a contact or any email address. The
  person opens it, sets a password and becomes a member login.
- **Member chats**: read each member's chat with the team agent.
- **Review**: items members submitted for review.
- **Requests**: change requests filed through the team agent.
- **Shared links**: the public links you have given out, to preview or revoke.
- **Clients**: client logins and their sign-in links.
- **What clients see**: every item at Client level.
- **Chat archive**: old portal chats, kept as read-only history.
- **Settings**: **Member chat** (members can chat only after you click **Let
  members chat**: it moves the team agent to Team level), and **Expose email &
  journal**, off by default.

Disable, demote or delete a login in [Logins](users.md) and its access ends at
once. How-to: [Member and client logins](../05-admin/07-logins.md).

## Assistant

- "What has the team been asking about this week?"
- "Has anyone raised anything about the pump job?"

Your assistant can read member chats and the access log. The team agent that
answers members is a different agent with a much smaller grant, and cannot
read this view.

## Technical

The team agent is read-only except for one write: filing a change request into
your Requests queue, stamped with who asked. It has no sending, delegation,
shell or bulk export. What it can read is capped by its access level, so a
member never reaches items above Team level. Email and journal reads stay off
until you switch on **Expose email & journal**.

Every request re-checks the login, so a disabled or deleted login loses access
mid-session. Your assistant reads this screen's data with `team_chat_list`,
`team_chat_read` and `team_access_list`.
