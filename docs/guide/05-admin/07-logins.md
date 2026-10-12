# Add logins

Give other people their own login to the brain. You need to be a user of the Admin workspace.

A login gives no rights by itself. What a person reads and changes comes from the workspaces they are in. See [Who can use a brain](../04-concepts/05-access-tiers.md).

## Invite a member

1. Open **Settings > Logins** and click **Invite**.
2. Enter the email and, if you like, a name.
3. Click **Create invite**.
4. Copy the **Invite link** and send it to the person.

The person opens the link, sets a password and is signed in. The link works once, for 72 hours. A new invite for the same person replaces the old link. Open invites stay at the top of the list until they are used: select one to **Revoke** it or make a **New link**.

You can also make a login directly: **Settings > Logins > Add login**. Give the person the email and starting password yourself.

A new login joins the Team workspace as a Moderator. To give it more, add it to other workspaces in **Settings > Workspaces**.

## Add another admin

An admin is a user of the Admin workspace. Either:

- open **Settings > Workspaces > Admin** and add the user, or
- open **Settings > Logins**, click **Add login** and set **Role** to Admin.

Admins manage the brain. They read what is granted to the workspaces they are in, like anyone. They do not read another user's private workspace or chats.

## Client logins

Client logins and emailed sign-in codes are gone. Every former client login was disabled, and it cannot be enabled again. An invite or a new login on a former client's email is refused. To work with people outside your company, make a workspace for them and add their logins.

## End someone's access

- Remove them from a workspace on **Settings > Workspaces**. They lose its items at once.
- **Settings > Logins**: select the login and switch on **Disabled**. Every session and API key it holds ends at once.
- **Sign out everywhere** on the same screen ends all sessions and API keys but keeps the login.

## Check it worked

The new login appears in **Settings > Logins**. After the person signs in, the row shows a **Last login** time.

## Next

- [Team and members](../03-using-jackdaw/12-team.md)
- [Security](10-security.md)
