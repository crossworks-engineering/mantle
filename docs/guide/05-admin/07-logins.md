# Add users

Give another person their own login to the brain. You need to be an admin (a user of the Admin workspace).

A login opens nothing by itself. What the person reads and changes comes from the workspaces you add them to. See [Who can use a brain](../04-concepts/05-access-tiers.md).

## Invite someone

1. Open **Settings > Users** and click **Invite**.
2. Enter their email and, if you like, a name.
3. Click **Create invite** and copy the **Invite link**.
4. Send the link to the person yourself. MantleOS does not email it.

They open the link, set a password and are signed in. The link works once, for 72 hours. A new invite for the same person replaces the old link. Open invites stay at the top of the list until they are used: select one to **Revoke** it or make a **New link**.

You can also make the login yourself: **Settings > Users > Add user**. Give the person the email and the **Starting password**; they can change it after they sign in.

## Let people sign in with their company account

Company sign-in (single sign-on) lets people use their work account instead of a password. It works with any OpenID Connect provider, the standard behind Entra ID, Okta, Keycloak and others. The operator turns it on in `.env` ([Environment variables](03-env-vars.md#company-sign-in-optional)); nobody can turn it off from the app.

- **Optional**: passwords keep working, and a person may link their company account.
- **Required**: a linked login signs in with the company account only. An unlinked login signs in with its password once, then must link. The original account keeps its password, so there is always a way in.

An admin may mark a login as an outside person, someone not in the company's provider. In required mode that login keeps its password. Set-up per provider: [docs/oidc-sign-in.md](../../oidc-sign-in.md) and [Entra ID](../../oidc-entra.md).

## Give them access

A new login gets only its own private workspace. Add it to the workspaces it should reach in **Settings > Workspaces** ([Workspaces and people](../03-using-jackdaw/12-team.md)).

## Add another admin

Open **Settings > Workspaces > Admin** and add the user. An admin manages the brain, and reads only what is shared with the workspaces they are in. No admin reads another user's private workspace or chats.

## End someone's access

- Remove them from a workspace in **Settings > Workspaces**. They lose its items at once.
- **Settings > Users**: select the login and switch on **Disabled**. Every session and API key it holds ends at once.
- **Sign out everywhere** on the same screen ends all sessions and API keys but keeps the login.

MantleOS no longer has client logins or emailed sign-in codes, and a former client login stays disabled. To work with people outside your company, make a workspace for them and add their logins.

## Check it worked

The new login appears in **Settings > Users**. After the person signs in, it shows a **Last login** time.

## Next

- [Workspaces and people](../03-using-jackdaw/12-team.md)
- [Security](10-security.md)
