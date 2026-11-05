# SCIM with Microsoft Entra ID

A guide for one provider. Mantle has no Entra code: Entra is set up like
any SCIM client ([scim.md](scim.md)). A box that sets none of this never
hears from Microsoft.

Use the same enterprise application as company sign-in
([oidc-entra.md](oidc-entra.md)), so the people assigned to sign in are the
people provisioned. One per site (decision D4).

## On the box

Make a token and put its hash in the box `.env` ([scim.md](scim.md), "Turn
it on"), then restart:

```bash
pnpm -C server/web scim-token
```

## In the Entra admin center

1. **Enterprise applications > the app > Provisioning > Get started.** Set
   the provisioning mode to **Automatic**.
2. **Admin credentials:**
   - Tenant URL: `https://<your brain>/scim/v2?aadOptscim062020`
     (`MANTLE_PUBLIC_URL` plus `/scim/v2`). The query word asks Entra for
     its newer, standard PATCH shapes; Mantle reads both, so it may be left
     out.
   - Secret token: the token from `scim-token`.
   - **Test connection** must pass. A 404 means the box has no
     `MANTLE_SCIM_TOKEN_HASH` (or the app was not restarted); a 401 a wrong
     token.
3. **Mappings > Provision Microsoft Entra ID Groups:** set **Enabled** to
   No. Mantle has no groups; access is given with workspaces, in Mantle.
4. **Mappings > Provision Microsoft Entra ID Users:**
   - Keep `userPrincipalName` to `userName` (the login's email) as the
     matching attribute (precedence 1), and `Switch([IsSoftDeleted], …)`
     to `active`.
   - Map `objectId` to `externalId` in place of `mailNickname`, before the
     first cycle: the object id never changes and is never given to another
     person, and Mantle keeps the first externalId it gets (a different one
     later is refused). Set **Match objects using this attribute** to Yes on
     it, precedence 2: after **Restart provisioning**, Entra finds its active
     people by UPN and the disabled ones by object id (Mantle never finds a
     disabled login by its email).
   - Never turn matching on for externalId while it still maps
     `mailNickname`: a mail alias can be given to a new person, who would
     then be matched to the leaver's login.
   - `displayName` is kept. Other attributes (name parts, emails, title,
     department, manager) are accepted and left alone; remove them to keep
     the logs short.
5. **Settings > Scope:** "Sync only assigned users and groups". Assign the
   same people and groups as for sign-in, with **Assignment required** on.
   Do not assign the account behind Mantle's original account (the
   emergency admin): SCIM never touches it, and its password stays in the
   company's vault.
6. Set **Provisioning Status** to On and save.

## What happens when

| In Entra                                     | Entra sends            | In Mantle                                         |
| -------------------------------------------- | ---------------------- | ------------------------------------------------- |
| a person is assigned                         | GET filter, then POST  | a member login, no password, no workspace         |
| a person already with a login is assigned    | GET filter, then PATCH | the login is marked as Entra's                    |
| sign-in is blocked, or the person unassigned | PATCH `active` false   | the users area's disable: everything ends at once |
| the person is deleted for good               | DELETE                 | a disable; the login and its items stay           |
| the person is assigned again, or unblocked   | PATCH `active` true    | enabled, if Entra disabled it and it is a member  |
| the display name changes                     | PATCH `displayName`    | renamed (an Admin user is not)                    |
| the UPN changes                              | PATCH `userName`       | left as it was: the login keeps its email         |

A login an admin disabled in Mantle stays disabled, and so does an Admin
user Entra disabled: an admin enables them by hand. A new person who is
given a leaver's address gets no login (Entra reports a 409 for them): the
leaver's login keeps its Entra object id, and an admin decides.

Entra runs a provisioning cycle about every 40 minutes, and the interval
is fixed (Microsoft's SCIM tutorial). A leaver is cut off at the next cycle,
or at once with **Provision on demand** on that person. Until the cycle
runs, a company sign-in session ends by itself after
`MANTLE_OIDC_SESSION_HOURS` (decision D8: 12 hours).

Test one leaver before go-live: assign a test user, wait for (or run on
demand) a cycle, have them sign in and make an API key, block them in
Entra, run the cycle again, and check that the login is disabled and the
key is gone (Settings > Users, or `GET /api/users/:id/left-behind`).

## New people signing in

A login Entra creates has no password. Set `MANTLE_SCIM_AUTO_LINK=on` in the
box `.env` (beside the SCIM and company sign-in settings, same enterprise
app) and the person signs in with Microsoft at once: Mantle links the login
by the ID token's `oid`, which must equal the login's externalId (the
`objectId` mapping above), in the tenant of `MANTLE_OIDC_ISSUER`. Use the
tenant-specific issuer (`https://login.microsoftonline.com/<tenant id>/v2.0`):
an issuer that names no tenant links nobody. Admin users and logins made by
hand still link themselves (docs/scim.md, "Signing in the first time").

Without it, an admin sets a first password (**Reset password**), the person
signs in with it once and links, then uses Microsoft from then on.
