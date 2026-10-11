---
title: Logins
---

## Logins

Logins are the ways into this brain. Every login has a role:

- **Admin**: a full co-owner. Sees the whole brain and every setting.
- **Member**: sees only items set to Team level or lower, in their own space,
  and chats with the team agent. Admin screens refuse it.
- **Client**: sees only items set to Client level, and signs in with a link
  you issue here.

The first login is the anchor: the brain is keyed to it, so it cannot be
deleted.

The list shows, from the top: **Open invites** (while any is open), the admin
and member logins, then **Clients**.

**Invite** makes an invite link for a new member. The person opens it, sets a
password and becomes a member login. Select an open invite to **Revoke** it or
make a **New link**. **Add login** takes an **Email**, a **Starting password**
(at least 8 characters) and an optional **Display name**. Steps for both:
[Member and client logins](../05-admin/07-logins.md).

Select a login to:

- change its **Role**, or switch on **Disabled** to block it;
- **Reset password**;
- see its devices and **Revoke** one, or **Sign out everywhere**. A revoke
  also signs out the browser tab that signed in on that device;
- give it its own assistant (**Create assistant**), so its chats run on their
  own thread, or let it share the brain's default assistant;
- for a member or client, click **Chat** in the header to read its chat with
  the team agent;
- on your own login, show a code to sign in on your phone.

**Clients** holds **Client settings**: the mail account that sends sign-in
codes. Then the client logins that already exist. New client logins can no
longer be added, and sign-in links are gone: a client signs in with an
emailed code.

## Assistant

The assistant cannot add, change or remove logins. Use this screen. You can
ask how logins work:

- "What can a member login see?"
- "How do I sign in on my phone?"

## Technical

Logins are rows in `auth.users`, each with a role of `admin`, `member` or
`client`. Invites and the chats are served by the same admin-only routes as
before they moved here. Passwords are stored only as a hash, so a reset sets a new one; there
is no recovery email. Each session carries a counter that is checked on every
request: a password change, disable, role change or **Sign out everywhere**
bumps it and ends every session of that login at once.

A password guards the door; the master key guards the sealed data. Changing a
password re-encrypts nothing, and someone with a copy of the database but no
master key cannot read secrets, API keys or mail credentials.
