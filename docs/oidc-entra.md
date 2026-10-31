# Company sign-in with Microsoft Entra ID

A guide for one provider. Mantle has no Entra code: Entra is set up like any
OIDC provider ([oidc-sign-in.md](oidc-sign-in.md)). A box that sets none of
this never calls Microsoft.

## In the Entra admin center

1. **App registrations > New registration.** One registration per site
   (decision D4): IT can give each person access site by site, and one
   secret stays on one box.
   - Supported account types: this organizational directory only (single
     tenant).
   - Redirect URI, platform **Web**: `https://<your brain>/api/auth/oidc/callback`
     (`MANTLE_PUBLIC_URL` plus `/api/auth/oidc/callback`).
2. **Certificates & secrets > New client secret.** Copy the value once.
   Note its expiry: sign-in stops when it expires.
3. **Enterprise applications > the app > Properties:** set **Assignment
   required** to Yes, then assign the people or groups who may sign in.
   Someone not assigned is refused by Entra and comes back to Mantle as
   `?oidc=cancelled`.
4. Multi-factor sign-in, Conditional Access and the sign-in logs all come
   from Entra. Mantle needs nothing more for them.

## In the box .env

```bash
MANTLE_OIDC_MODE=optional
MANTLE_OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
MANTLE_OIDC_CLIENT_ID=<application (client) id>
MANTLE_OIDC_CLIENT_SECRET=<the secret value>
MANTLE_OIDC_LABEL=Microsoft
MANTLE_OIDC_SESSION_HOURS=12
```

Use the tenant id, never `common` or `organizations`: the ID token's issuer
must equal `MANTLE_OIDC_ISSUER`. Restart the web service after a change.

Entra's subject is tied to the tenant and the app; Mantle keeps the `tid`
and `oid` claims beside it on each link.

## Move a site

Start in `optional`. Each person links from the offer after a password
sign-in. When the users area shows every active login linked (or marked an
outside person), switch to `required` and restart. The boot ends the
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
mode), until an admin disables the login in Mantle. SCIM (Phase 5) closes
that gap; until then, disable a leaver in Mantle the same day.
