---
title: Users
---

## Users

Each user is one login, one way into this brain. A login gives no rights by itself:
what a person reads and changes comes from the workspaces they are in
(**Settings > Workspaces**).

- **Admin**: a user of the Admin workspace. Admins manage the brain. To make
  someone an admin, add them to the Admin workspace.
- **Member**: every other login.

The first login is the anchor: the brain is keyed to it, so it cannot be
deleted.

**Open invites** come first in the list, then the logins.

**Invite** makes a link and a code for a new member. Nothing is emailed: you
hand the link over. It works once and expires in 72 hours. The person sets a
password and becomes a member, in no workspace but their own private one.
Select an open invite to **Revoke** it or make a **New link**.

**Add user** takes an **Email**, a **Starting password** and an optional
**Display name**. The email is the login and cannot be changed later. Pass the
password on yourself. Steps for both: [Add users](../05-admin/07-logins.md).

Every new password must pass [the rule](../../policy.md#passwords): at least 8
characters (more if the box sets a higher minimum), and three of small
letters, capitals, digits and symbols, unless it has 20 characters or more. A
common password is refused. A strength bar and a tick per part of the rule
show how a password does as you type.

Select a login to:

- change its **Display name** and **Description** (who they are to the team,
  shown on their card to everyone, agents too), then **Save user**;
- switch on **Disabled** to block it;
- **Reset password**. The old password stops working the moment you save;
- see its **Devices** and **Revoke** one, or **Sign out everywhere**: every
  browser, the phone app and any connected client must sign in again;
- on an admin login only, give it its own **Assistant** (**Create
  assistant**, a copy of the agent you pick in **Copy from**), rename it, or
  **Release** it. Each user has their own thread with every
  assistant, so chats never mix;
- on your own login, **Show a code** to sign in on your phone;
- **Delete login** (not on the anchor or your own login). What they made stays.

The old Settings > Security screen now lives here, per login.

Client logins are gone. A former client login stays disabled for good.

## Assistant

The assistant cannot add, change or remove logins. You can ask how logins
work:

- "What can a member login see?"
- "How do I sign in on my phone?"

Each user's chats are their own. No admin reads another user's chat.

## Technical

Logins are rows in `auth.users`, each with a role of `admin` or `member`.
The role follows the Admin workspace and grants nothing by itself; every
read and write is checked against the login's workspaces
(docs/workspaces.md). Passwords are stored only as a hash, so a reset sets
a new one; there is no recovery email. A password is at most 72 bytes. Each
session carries a counter that is checked on every request: a password
change, disable, a move in or out of Admin or **Sign out everywhere** bumps
it and ends every session and API key of that login at once.

With company sign-in (single sign-on, set in the box's `.env`) on, a login can
be linked to a company account. This screen does not show links yet:
`GET /api/users/oidc` lists them and `DELETE /api/users/:id/oidc` removes one
(docs/oidc-sign-in.md).

With SCIM on (set in the box's `.env`, or made at Settings > Company sign-in
while the mode is `setup`), the company's directory adds member
logins and disables the ones it blocks, through the same disable as this
screen. `GET /api/users/scim` says whether it is on and how many logins it
manages; `GET /api/users/:id/left-behind` lists what a disabled login left
(docs/scim.md).

A password guards the door; the master key guards the sealed data. Changing
a password re-encrypts nothing, and someone with a copy of the database but
no master key cannot read secrets, API keys or mail credentials.
