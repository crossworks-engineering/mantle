# Company sign-in with Microsoft Entra ID

A guide for one provider. Mantle has no Entra code: Entra is set up like any
OIDC provider ([oidc-sign-in.md](oidc-sign-in.md)). A box that sets none of
this never calls Microsoft.

## Two apps in Entra

Company sign-in uses one app. SCIM needs a second one. Microsoft does not
turn on automatic provisioning for an app made under App registrations: its
enterprise app cannot do SCIM. Microsoft's answer is a second, non-gallery
app for provisioning (Microsoft Learn, "Known issues for provisioning",
"Automatic provisioning isn't available on my OIDC-based application").

| App                  | Made in                                           | Holds                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| The sign-in app      | **App registrations**                             | The redirect URI, the client secret, the `auth_time` claim |
| The provisioning app | **Enterprise apps > Create your own application** | SCIM ([scim-entra.md](scim-entra.md))                      |

Assign the same people and groups to both. Who may sign in comes from the
sign-in app. Who has a login comes from the provisioning app. A box without
SCIM needs the sign-in app only.

## In the Entra admin center

Menu names are from Microsoft Learn (November 2026). Microsoft changes them
often: if one differs a little, take the nearest match.

1. **Entra ID > App registrations > New registration.** One registration
   per site (decision D4): IT can give each person access site by site, and
   one secret stays on one box.
   - **Supported account types:** **Single tenant only - <your tenant>**.
   - **Redirect URI**, platform **Web**: `https://<your brain>/api/auth/oidc/callback`
     (`MANTLE_PUBLIC_URL` plus `/api/auth/oidc/callback`).
   - On the app's **Overview**, copy the **Application (client) ID** and the
     **Directory (tenant) ID**.
2. **Certificates & secrets > Client secrets > New client secret.** Copy the
   **Value** once (not the Secret ID). Mantle takes a client secret only, sent
   in the token request body (`client_secret_post`): not a certificate, not a
   federated credential. Note the expiry date: nothing in Mantle warns before
   it, and sign-in stops on that day (Entra then answers `AADSTS7000222`).
3. **Token configuration > Add optional claim**, token type **ID**, claim
   `auth_time` (see "Move a site" below for why).
4. **Entra ID > Enterprise apps > All applications**, open the sign-in app
   (Entra made it at the registration), **Properties**: set **Assignment
   required?** to Yes. Then **Users and groups > Add user/group** and assign
   the people or groups who may sign in. Someone not assigned is refused by
   Entra (`AADSTS50105`) and comes back to Mantle as `?oidc=cancelled`. A
   Global Administrator can sign in to the app whatever this setting says
   (Microsoft's rule); Mantle still needs a linked login.
5. Multi-factor sign-in, Conditional Access and the sign-in logs all come
   from Entra. Mantle needs nothing more for them.

**The Test button and Assignment required.** The setup screen's Test asks
Entra for an app-only token for the sign-in app itself (client credentials,
scope `<client id>/.default`). Microsoft says that with **Assignment
required?** on Yes, an app must be assigned to get a token. The sign-in app is
not assigned to itself, so Entra may refuse it, and the Test then answers
`unclear` with a good secret. This is not yet tested on a real tenant. If you
see `unclear`, lock the screen and try a real sign-in before you change
anything. A wrong secret still reads `secret-refused`.

## In the box .env

With the setup screen, the admin enters the secret on the screen and the owner
never handles it ([oidc-sign-in.md](oidc-sign-in.md), "The setup screen"). The
owner gives the admin the box address. The admin registers the app as above and
sends the owner the tenant id and the client id. The owner sets
`MANTLE_OIDC_MODE=setup` with the issuer and the client id, and leaves the secret
out.

From an operator machine, `scripts/sso-env.sh <box-label> --tenant <tenant id>
--client <client id>` does this over ssh: it backs up `.env`, writes only the
lines that change, runs `docker compose up -d` and checks that web runs with
them. `--dry-run` prints what would change, and `--mode off` turns company
sign-in off again. The issuer stays out of the app on purpose: who sets it
decides who can sign in.

**With a Control Center** (the shorter path, [oidc-sign-in.md](oidc-sign-in.md),
"From the Control Center"): the owner only sets the mode,
`scripts/sso-env.sh <box-label> --mode setup`. The admin enters the tenant
id, the client id and the secret once, at the CC's Fleet > Company sign-in
page, presses Test, and the owner goes live with `--mode optional`. No Admin
login on each box, and the secret never changes hands. The CC can stage the
tenant and the client id only while the box is in `setup`: going live stays
the owner's `.env` step. Later, a new secret goes in from the same page in
any mode; on a live box it is saved only when its Test passes.

With the secret in the `.env`:

```bash
MANTLE_OIDC_MODE=optional
MANTLE_OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
MANTLE_OIDC_CLIENT_ID=<application (client) id>
MANTLE_OIDC_CLIENT_SECRET=<the secret value>
MANTLE_OIDC_LABEL=Microsoft
MANTLE_OIDC_SESSION_HOURS=12
```

Use the tenant id, never `common` or `organizations`: the ID token's issuer
must equal `MANTLE_OIDC_ISSUER`. Run `docker compose up -d` after a change: a
plain restart does not apply it.

Entra's subject is tied to the tenant and the app; Mantle keeps the `tid`
and `oid` claims beside it on each link.

## Move a site

Start in `optional`. Each person links from the offer after a password
sign-in. When the users area shows every active login linked (or marked an
outside person), switch to `required` and run `docker compose up -d`. The boot ends the
sessions of every company login (links kept): each person signs in again,
with the company account once linked, so nothing from the optional weeks
lives on, and going back to optional later revives none. Outside people
keep their passwords once an admin marks them (unless the operator set
`MANTLE_OIDC_OUTSIDE=off`). Keep
the original account's password in the company's vault: it is the
emergency admin.

Add `auth_time` as an optional claim of the ID token under Token
configuration. Mantle asks Entra for a fresh sign-in (`prompt=login`,
`max_age=0`) on the desktop app, on the phone, at key creation and at MCP
consent, and refuses one whose ID token has no `auth_time`: without the claim
those four fail for every linked person.

Company sign-in alone does not stop a leaver. A block in Entra ends their
company sign-in when that session ends (`MANTLE_OIDC_SESSION_HOURS`), but an
API key or an MCP grant they made lives on, and so does their password
where it still works (the original account, an outside person, optional
mode), until an admin disables the login in Mantle. SCIM closes that gap:
set it up on the second, provisioning app, with the same people assigned
([scim-entra.md](scim-entra.md)). Without it, disable a leaver in Mantle the
same day.
