# SCIM with Microsoft Entra ID

A guide for one provider. Mantle has no Entra code: Entra is set up like
any SCIM client ([scim.md](scim.md)). SCIM runs on a Control Center only
([control-center.md](control-center.md)): point the provider at the CC. A box
that sets none of this never hears from Microsoft.

SCIM needs its own app in Entra, a second one beside the sign-in app of
[oidc-entra.md](oidc-entra.md). Microsoft does not turn on automatic
provisioning for an app made under App registrations, so the sign-in app
cannot do SCIM. Make a non-gallery enterprise app for provisioning, and
assign it the same people and groups as the sign-in app, so the people who
may sign in are the people provisioned (Microsoft Learn, "Known issues for
provisioning"). One pair per site (decision D4).

## On a Control Center

Every SCIM disable on the CC also bans the person on every linked box
([control-center.md](control-center.md), "The SCIM trigger"). So on the CC,
two rules replace "the same people and groups" below:

- Assign the provisioning app ONE wide group (all staff) and never narrow
  it. Entra sends `active` false when a person is unassigned or leaves the
  scope, and that is now a fleet ban.
- Assign the CC's sign-in app (of [oidc-entra.md](oidc-entra.md)) to the CC
  Admins only, so a provisioned employee cannot sign in to the CC.

## On the box

On the setup screen, the admin makes the token at Admin > Company sign-in
while `MANTLE_OIDC_MODE=setup` ([oidc-sign-in.md](oidc-sign-in.md), "The setup
screen"). It works at once, and shows once.

Or make a token and put its hash in the box `.env` ([scim.md](scim.md), "Turn
it on"), then run `docker compose up -d`:

```bash
pnpm -C server/web scim-token
```

## In the Entra admin center

Menu names are from Microsoft Learn (November 2026). Microsoft changes them
often: if one differs a little, take the nearest match. Provisioning needs at
least the Application Administrator role.

1. **Make the provisioning app.** **Entra ID > Enterprise apps > + New
   application > + Create your own application.** Give it a name, choose
   **Integrate any other application you don't find in the gallery
   (Non-gallery)**, and select **Add** (some screens say **Create**). In its
   **Properties**, set **Assignment required?** to Yes and **Visible to
   users?** to No: people sign in through the sign-in app, not this one.
2. **Assign people.** **Users and groups > Add user/group.** Assign the same
   people and groups as on the sign-in app. Only direct members of an
   assigned group are provisioned: nested groups are not. Do not assign the
   account behind Mantle's original account (the emergency admin): SCIM
   never touches it, and its password stays in the company's vault.
3. **Provisioning > + New configuration** (on an older screen: **Get
   started**, then **Provisioning Mode** **Automatic**). Under the admin
   credentials, use the secret token (long-lived bearer token) method. Mantle
   does not offer OAuth2 Client Credentials Grant.
   - **Tenant URL:** `https://<your brain>/scim/v2?aadOptscim062020`
     (`MANTLE_PUBLIC_URL` plus `/scim/v2`). The query word asks Entra for
     its newer, standard PATCH shapes; Mantle reads both, so it may be left
     out. Microsoft says the word does not apply to Provision on demand,
     which sends the older shapes: Mantle reads those too.
   - **Secret Token:** the token from the screen or from `scim-token`.
   - **Test Connection** must pass, then select **Create**. A 404 means the
     box has no token, or `MANTLE_SCIM_TOKEN_HASH` holds another value, or
     the mode is off (or the `.env` change was not applied); a 401 a wrong
     token.
4. **Attribute mapping** (older screen: **Mappings**), the groups set
   (**Provision Microsoft Entra ID Groups**): turn it off. Mantle has no
   groups; access is given with workspaces, in Mantle.
5. **Attribute mapping**, the users set (**Provision Microsoft Entra ID
   Users**):
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
6. **Settings** (newer screen: **Overview > Properties**, the pencil): scope
   **Sync only assigned users and groups**; a notification email; accidental
   deletions prevention on. **Save** (newer screen: **Apply**).
7. **Provision on demand:** provision one assigned test person, and check
   that the login shows in Settings > Users.
8. Set **Provisioning Status** to On and save (newer screen: **Start
   provisioning**).

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
is fixed (Microsoft's SCIM tutorial). A leaver is cut off at the next cycle.
**Provision on demand** is faster only for a person unassigned from the
provisioning app: run it on that person and the login is disabled at once.
It cannot disable a person blocked or deleted in Entra (Microsoft: such a
person does not show in its search), so that person waits for the next
cycle. Until the cycle runs, a company sign-in session ends by itself after
`MANTLE_OIDC_SESSION_HOURS` (decision D8: 12 hours). For a leaver who must
go now, an admin disables the login in Settings > Users as well.

Test one leaver before go-live: assign a test user, run Provision on demand
on them, have them sign in and make an API key, unassign them from the
provisioning app, run Provision on demand again, and check that the login is
disabled and the key is gone (Settings > Users, or
`GET /api/users/:id/left-behind`). Then block a second test user in Entra,
wait for the next cycle, and check that their login is disabled.

## New people signing in

A login Entra creates has no password. Set `MANTLE_SCIM_AUTO_LINK=on` in the
box `.env` (beside the SCIM and company sign-in settings) and the person signs in with Microsoft at once: Mantle links the login
by the ID token's `oid`, which must equal the login's externalId (the
`objectId` mapping above), in the tenant of `MANTLE_OIDC_ISSUER`. Use the
tenant-specific issuer (`https://login.microsoftonline.com/<tenant id>/v2.0`):
an issuer that names no tenant links nobody. It works for a person's first
sign-in only: once they have signed in, an unlink is never undone by it. Admin users and logins made by
hand still link themselves (docs/scim.md, "Signing in the first time").

Without it, an admin sets a first password (**Reset password**), the person
signs in with it once and links, then uses Microsoft from then on.
