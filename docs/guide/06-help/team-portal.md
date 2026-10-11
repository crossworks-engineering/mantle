---
title: Team Portal
toolGroups: []
---

## Team Portal

The team portal and its team codes are retired. Old codes no longer work, and
Jackdaw no longer shows this screen in the menu.

Your team now signs in with its own logins:

1. Open **Settings > Logins** and click **Invite**.
2. Make an invite link for an email address.
3. Send the link. The person sets a password and signs in as a member.

Members chat with the Team workspace's assistant, each in their own thread.
Old portal chats are kept as history in the database; nobody reads them in
the app any more. See [Logins](users.md) and
[Member and client logins](../05-admin/07-logins.md).

## Assistant

- "How do I invite someone to the team?"

Each user's chats are their own: the assistant reads no member's chat and no
old portal thread.

## Technical

Member logins replaced the portal. A member is an ordinary login with the
member role, so disabling or deleting it ends its access at once. The old
portal threads are kept in `archive_team_messages` as history; nothing new is
written to them, and the team chat tools that read them are gone.
