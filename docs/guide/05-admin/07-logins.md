# Add users

Give another person their own login to the brain. You need to be an admin (a user of the Admin workspace).

A login opens nothing by itself. What the person reads and changes comes from the workspaces you add them to. See [Who can use a brain](../04-concepts/05-access-tiers.md).

## Invite someone

1. Open **Settings > Users** and click **Invite**.
2. Pick a **Contact** to use their email and name, or enter an email and, if you like, a name.
3. Click **Create invite** and copy the **Invite link**.
4. Send the link to the person yourself. MantleOS does not email it.

They open the link, set a password and are signed in. The link works once, for 72 hours. A new invite for the same person replaces the old link. Open invites stay at the top of the list until they are used: select one to **Revoke** it or make a **New link**.

You can also make the login yourself: **Settings > Users > Add user**. Give the person the email and the **Starting password**; they can change it after they sign in.

## The password rule

Every new password (at sign-up, an invite, **Add user**, **Reset password** or a change) must:

- have at least 8 characters, or the box policy's minimum if that is higher ([Environment variables](03-env-vars.md#box-policy));
- use three of small letters, capitals, digits and symbols, unless it is a passphrase of 20 characters or more;
- not be a common password, such as `Pass1234`.

The form shows the rule as the person types. A password set before the rule keeps working. Only a box policy asks for a change at sign-in.

## Let people sign in with their company account

Company sign-in (single sign-on) lets people use their work account instead of a password. It works with any OpenID Connect provider, the standard behind Entra ID, Okta, Keycloak and others. The operator turns it on in `.env` ([Environment variables](03-env-vars.md#company-sign-in-optional)); nobody can turn it off from the app.

- **Optional**: passwords keep working, and a person may link their company account.
- **Required**: a linked login signs in with the company account only. An unlinked login signs in with its password once, then must link. The original account keeps its password, so there is always a way in.

The app has the company sign-in screens: **Sign in with {label}** on the sign-in page, an offer card to link after a password sign-in, the link part of **Settings > Profile**, and the setup screen at **Settings > Company sign-in**. The phone app has no company sign-in yet, so people who use it keep their passwords. Settings > Users does not show or remove a person's link yet. Until it does, do not use `required`.

An admin may mark a login as an outside person, someone not in the company's provider. In required mode that login keeps its password. Set-up per provider: [docs/oidc-sign-in.md](../../oidc-sign-in.md) and [Entra ID](../../oidc-entra.md).

## Let the company's directory add and remove people

With SCIM, the company's directory (Entra ID, Okta and others) adds a login for each person it gives access to, and disables the login of a person it blocks or removes, at its next sync. The disable is the same as **Disable** here: every session, API key and connector of that person ends at once. Nothing they made is deleted. The operator turns it on in `.env` ([Environment variables](03-env-vars.md#scim-optional)). SCIM runs on a Control Center only: on any other box it is off ([docs/control-center.md](../../control-center.md)).

- On Entra, SCIM needs a second app beside the sign-in app: Entra cannot provision from an app made under App registrations. Assign the same people to both ([Entra ID](../../scim-entra.md)).
- The owner sets the mode to `setup` in `.env`, and an Admin makes the directory's token at Settings > Company sign-in. It shows once, and it works at once. That login holds all five Admin areas and can reset any password, so give it only to a person you trust as a box admin ([docs/oidc-sign-in.md](../../oidc-sign-in.md)).
- A login the directory adds is a member with no workspace and no password. Add it to its workspaces. With `MANTLE_SCIM_AUTO_LINK=on` the person signs in with the company account at once; without it, set a first password so they can sign in once and link.
- The directory never touches the original account, and never makes an admin.
- The directory enables again only a member it disabled itself. A login you disable here stays disabled, and so does an admin the directory disabled: enable those here.
- After a leaver goes, `GET /api/users/<id>/left-behind` lists what they left: their private items and the share links of those items, which keep working until you revoke them.

Set-up: [docs/scim.md](../../scim.md) and [Entra ID](../../scim-entra.md).

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
