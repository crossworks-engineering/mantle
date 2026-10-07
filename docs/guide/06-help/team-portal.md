---
title: Team Portal
toolGroups: [team-admin]
---

## Team Portal

The team portal and its team codes are retired. Old codes no longer work, and
Jackdaw no longer shows this screen in the menu.

Your team now signs in with its own logins:

1. Open **Team** and go to the **Invites** tab.
2. Make an invite link for a contact or an email address.
3. Send the link. The person sets a password and signs in as a member.

Members chat with the team agent from their own space. Old portal chats are
kept in the **Chat archive** tab, and each contact there can be invited as a
member. See [Team](team-admin.md) and [Member and client
logins](../05-admin/07-logins.md).

## Assistant

- "What has the team been asking about this week?"
- "What did members ask in the old portal chats?"

The assistant reads member chats, the old portal threads and the access log
through the team admin tools.

## Technical

Member logins replaced the portal. A member is an ordinary login with the
member role, so disabling or deleting it ends its access at once. The old
portal threads stay readable as history; nothing new is written to them. The
assistant uses `team_chat_list`, `team_chat_read` and `team_access_list`.
