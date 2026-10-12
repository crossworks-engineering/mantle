---
title: Logins
---

## Logins

Logins are the ways into this brain. A login gives no rights by itself:
what a person reads and changes comes from the workspaces they are in
(**Settings > Workspaces**).

- **Admin**: a user of the Admin workspace. Admins manage the brain, and
  read what their workspaces hold, like anyone.
- **Member**: every other login.

The first login is the anchor: the brain is keyed to it, so it cannot be
deleted.

The list shows **Open invites** first (while any is open), then the
logins.

**Invite** makes an invite link for a new member. The person opens it, sets
a password and becomes a member login, a Moderator of the Team workspace.
Select an open invite to **Revoke** it or make a **New link**. **Add
login** takes an **Email**, a **Starting password** (at least 8
characters) and an optional **Display name**. Steps for both:
[Add logins](../05-admin/07-logins.md).

Select a login to:

- change its **Role** (Admin adds it to the Admin workspace), or switch on
  **Disabled** to block it;
- **Reset password**;
- see its devices and **Revoke** one, or **Sign out everywhere**. A revoke
  also signs out the browser tab that signed in on that device;
- give it its own assistant (**Create assistant**), so its chats run on
  their own thread, or let it share the brain's default assistant;
- on your own login, show a code to sign in on your phone.

Client logins are gone. A former client login stays disabled and cannot be
enabled again.

## Assistant

The assistant cannot add, change or remove logins. Use this screen. You can
ask how logins work:

- "What can a member login see?"
- "How do I sign in on my phone?"

Each user's chats are their own. No admin reads another user's chat here
or anywhere else.

## Technical

Logins are rows in `auth.users`, each with a role of `admin` or `member`.
The role follows the Admin workspace and grants nothing by itself; every
read and write is checked against the login's workspaces
(docs/workspaces.md). Passwords are stored only as a hash, so a reset sets
a new one; there is no recovery email. Each session carries a counter that
is checked on every request: a password change, disable, role change or
**Sign out everywhere** bumps it and ends every session and API key of
that login at once.

A password guards the door; the master key guards the sealed data. Changing
a password re-encrypts nothing, and someone with a copy of the database but
no master key cannot read secrets, API keys or mail credentials.
