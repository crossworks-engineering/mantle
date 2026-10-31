# Company sign-in (OIDC)

A box can let people sign in with their company account through any
OpenID Connect provider (Keycloak, Okta, Authentik, Entra ID and others).
It is off unless the operator turns it on in the box `.env`. Off, nothing
changes: the same sign-in screen, passwords only, the same one-year
session, and no call to any provider (corporate plan section 2.1; the
acceptance test is `server/web/lib/oidc/oidc-off.test.ts`).

Code: `server/web/lib/oidc/` (settings, provider, cookies, rules, store,
flow), the routes under `server/web/app/api/auth/oidc/` and
`server/web/app/api/users/oidc/`, migration
`packages/db/migrations/0349_oidc_signin.sql`. A provider guide:
[oidc-entra.md](oidc-entra.md).

## Settings

| Variable                    | Default          | What it does                                                                                                                                                            |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_OIDC_MODE`          | `off`            | `off`, `optional` or `required`. Empty is off. An on word (`on`, `true`, `1`, `yes`) is `optional`, never `required`. Any other word stops the boot.                    |
| `MANTLE_OIDC_ISSUER`        |                  | The provider's issuer URL. The provider is read from `<issuer>/.well-known/openid-configuration`. `https` only; plain `http` only to a loopback host (a test provider). |
| `MANTLE_OIDC_CLIENT_ID`     |                  | The client id registered with the provider.                                                                                                                             |
| `MANTLE_OIDC_CLIENT_SECRET` |                  | Its secret. Empty: a public client (PKCE only).                                                                                                                         |
| `MANTLE_OIDC_LABEL`         | `Single sign-on` | The button's word: "Sign in with {label}". One line, at most 60 characters.                                                                                             |
| `MANTLE_OIDC_SESSION_HOURS` | `12`             | The life of a session made by company sign-in, 1 to 168 hours. Password sessions keep their one year.                                                                   |
| `MANTLE_OIDC_OUTSIDE`       | `on`             | Whether an admin's outside mark keeps a login's password in required mode (people outside the company, decision D3). Off: marks are refused and keep nothing.           |

Register `MANTLE_PUBLIC_URL/api/auth/oidc/callback` as the redirect URI.
`MANTLE_PUBLIC_URL` must be set. A mode that is on with the issuer, the
client id or `MANTLE_PUBLIC_URL` missing is off, with one log line: a
half-set box keeps its passwords.

The settings live in the `.env` only (decision D2): a box admin cannot turn
them off from the app. `docker-compose.yml` passes all seven to the app
container; a box with its own compose file must pass them too, or the mode
reads as off. A box serves one public URL: a link or sign-in started on
another hostname for the same box comes back to `MANTLE_PUBLIC_URL`, where
the flow cookie is not, and fails as expired.

## Modes

| Mode       | Password sign-in                                                                     | Company sign-in                                                                        |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `off`      | yes                                                                                  | no (config and status answer `{ mode: 'off' }`, every other company sign-in route 404) |
| `optional` | yes, for every login                                                                 | yes, for a linked login                                                                |
| `required` | the original account, outside logins, and an unlinked login once (then it must link) | yes, and the only way in for a linked login                                            |

Required mode never strands anyone (plan section 17.1):

- A linked login signs in with company sign-in only. Its password sign-in
  answers 403 `sso-required`.
- An unlinked login's password still works, but it gets no session. The
  answer is 403 `sso-link-required` with a 5-minute held ticket cookie: the
  one "Link your company sign-in" step starts on it, and the login is
  signed in once it is linked. No reset and no admin call.
- The original account (`auth.users.is_owner`) keeps its password: the
  emergency admin.
- A login an admin marks as an outside person keeps its password
  (decision D3: people outside the company are not in its provider), only
  the operator has not turned outside logins off (`MANTLE_OIDC_OUTSIDE`,
  on by default as decision D3 has it; `off` locks the policy down so no
  admin can exempt anyone from the app). The mark is
  refused for the admin's own login, an Admin user, the original account
  and a linked login, and the rule holds whatever the order of steps: a
  linked login uses company sign-in only even if marked, and a mark gives
  no password to an Admin user (a promotion after the mark does not carry
  it). The users area's counts and the boot name how many marks keep a
  password. Clearing a mark in required mode ends that login's sessions.
  With `MANTLE_OIDC_OUTSIDE=off`, a person outside the company is held at
  a link step they cannot finish: leave it on while outside people have
  logins.
- The token logins (`/api/auth/token`, `/api/auth/device-login`,
  `/api/auth/mobile-login`) refuse both cases with 403 and set no ticket: a
  bearer client links on the web first.

If the provider is down, the operator sets the mode back to `optional`:
every login still has its password.

`required` with the issuer, the client id or `MANTLE_PUBLIC_URL` missing,
an issuer or public URL that is not a URL, or a plain `http` issuer that is
not a loopback test provider stops the boot (the policy would not apply,
or every linked login would be locked out). The boot logs one line when
company sign-in is on, and in required mode a warning while some active
logins are not linked (each of those signs in with its password once and
is asked to link) and one naming how many are marked outside people.

Required mode ends old sessions, not only new sign-ins. The mode is read
from the `.env` at start, so a switch is a boot, and at each boot in
required mode, on a switch into it (the last boot with company sign-in on
applied optional, or none did; `oidc_mode_state` records it), every active
login the rule refuses has its sessions ended (its epoch bumped, its device
bearers revoked and the push relay told, an `auth.oidc_sessions_ended`
audit row each; links and keys kept). No password session from before the
switch lives on, and setting the mode back to optional later revives none.
A linked person signs in again with the company account; an unlinked one
with the password, which holds them to the link step. A member's MCP
connectors (their grants follow the session epoch) need a new consent once.
A plain restart in required mode ends nothing. The step tries the database
again for a minute at start and records the mode only once every end
succeeded, so a failed step runs again at the next boot; meanwhile the
per-request hold refuses the old sessions. With company sign-in off nothing
is recorded, so a switch off and back to required ends nothing new: a
password session made while off is refused by the hold, and would come
back with optional (end such sessions with Sign out everywhere). Between boots one gate decides, on every request, whether a session may act
(`sessionHeld` in `server/web/lib/oidc/hold.ts`; every path asks it: the
cookie and the device bearer in the session, the bearer-to-cookie upgrade
and the token refresh; the boot step and the sign-in routes read its rule).
It reads the mode, the login's facts (linked, original account, outside
mark) and the session's kind and life left:

| Mode       | Password session (cookie without the mark, or a device bearer)    | Company sign-in session (cookie with the mark)                                                        |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `off`      | acts, no read                                                     | never acts                                                                                            |
| `optional` | acts, no read                                                     | acts while the login is linked to the issuer and its life left is at most `MANTLE_OIDC_SESSION_HOURS` |
| `required` | acts only for the original account and an honoured outside person | as in `optional`                                                                                      |

The facts are kept 10 seconds per login (forgotten at once on a link, an
unlink or an outside mark), and a failed read holds. API keys, MCP grants
and linked brains are not judged by it (Phase 5).

A person outside the company invited while the mode is `required` is held
at the link step they cannot finish: an admin marks the new login outside
(`PATCH /api/users/:id/oidc`) and the person signs in with the password they
chose.

## Links

A link is a row of `oidc_signin_links`: the login, the issuer and the
subject, unique on issuer plus subject (one account, one login) and on
login plus issuer (one account per login). `tid` and `oid` are kept beside
the subject when the provider sends them; nothing matches on them.

- Company sign-in never makes a login and never makes an admin. An
  account linked to no login signs nobody in (`?oidc=not-linked`).
- A link is never made, or matched, on an email. An email can change, and
  matching on one lets a person take over an account.
- A link flow asks the provider to sign the person in again
  (`prompt=login`, `max_age=0`), so a link does not take whichever account
  the browser happens to be signed into. When the ID token says when the
  person signed in (`auth_time`), that time must be at or after the link
  started (one minute of clock skew allowed); an older one is refused. A
  provider that sends no `auth_time` is let through, with one log line:
  the fresh sign-in was asked for, not proven.
- A login links itself, in its own session, with one click right after a
  password sign-in on the same browser (the 5-minute ticket, used up when
  the link starts), or later with its password typed again (5 tries in 15
  minutes per login, each failure audited). A held login links on its held
  ticket.
- The login is told when a link is made on it (an Admin user's own phones,
  a member's thread with their assistant), as for an API key made.
- A link is removed only by an unlink: the login's own where it may, or an
  admin's (`DELETE /api/users/:id/oidc`). Nothing removes one as a side
  effect: not a password change or reset, a disable, a role change, sign
  out everywhere, End sessions or a stolen device token presented again.
  A removal would put the login back on "password, then link any company
  account" in required mode, so whoever knows the password could link
  their own. An unlink ends the login's sessions too, so a session the
  link made does not live on. A link someone else made (the person is told)
  goes the same way: an admin unlinks it.
- An account linked to another login is never moved (`?oidc=taken`); a
  login that holds a link must remove it before it links another account.
- A login removes its own link in optional mode (its password is then its
  only way in). In required mode only an admin removes it, except for the
  original account and an outside login.
- The provider must let only the company's people sign in to this client
  (no self-registration; an assignment or group gate, as Entra's
  "Assignment required"): in required mode an unlinked login's password
  plus any account the provider lets in is a link.
- The provider's subject must be stable and never given to another
  account: the provider's own immutable id. A provider that can be set to
  use a username or an email as the subject must not be (that brings back
  the takeover matching on email allows).

Every link made and every outside mark runs at the full-route spot
`oidc-link` (`packages/db/src/viewer.ts`): a link is a way in, so the narrow
role only reads the three tables (`packages/db/src/access-matrix.ts`).

## The flow

Authorization code with PKCE (S256), `state` and `nonce`, through
`openid-client`. The ID token's signature (against the provider's published
keys, `jwks_uri`), issuer, `aud`, expiry and nonce are checked by the
library; its issuer must also be `MANTLE_OIDC_ISSUER`
(one trailing slash is not a difference). Scopes: `openid profile`. The
discovered provider is kept an hour.

Two short cookies, both signed values of their own kind, `httpOnly`,
`__Host-` prefixed on https (Path=/, no Domain: a sibling subdomain or a
man in the middle cannot plant one, so a flow or ticket of someone else's
never reaches this brain), and neither a session:

- `mantle_oidc_flow` (10 minutes, `SameSite=Lax`): one flow from start to
  callback: state, nonce, PKCE verifier, the return path, and for a link the
  login and its session epoch. A password change, a sign out everywhere or
  a disable between start and callback ends the link.
- `mantle_oidc_ticket` (`SameSite=Strict`): a password sign-in on this
  browser just now, 5 minutes, used up when a link starts on
  it, set only while company sign-in is on. Sign out clears both cookies.

A session made by company sign-in is the normal session cookie
(`buildSessionCookie`) with the life of `MANTLE_OIDC_SESSION_HOURS`, marked
(`so`) so a re-mint of it (a password change) keeps the end it had and
never becomes a year, whatever bearer header rides along. Such a session
cannot pair a phone or a Telegram chat (403 `sso-session`): either would
be a session that outlives it. An API key or an MCP grant can still be made
from it (each asks for the password): those are credentials of their own,
not sessions, so the session gate does not judge them, and their leaver
rules are Phase 5 (plan section 10.3). Refusing them would shut a person
who signs in only with the company account out of MCP clients. Sign out ends the
Mantle session only (no single logout).

Failures go back to the browser as `?oidc=<code>`: `expired`, `cancelled`
(the provider said no), `failed` (the token did not verify), `unavailable`
(the provider could not be read), `not-linked`, `not-allowed` (a disabled
login), `taken`, `has-other`. A sign-in failure lands on `/login`; an
in-session link failure on the page the link started from. The provider's
own error text is never shown. A callback whose `state` is not this
browser's flow ends nothing. Every redirect the callback answers carries a
fragment of its own, so a code a provider sent in one never rides on to the
next page. Each failed callback writes an
`auth.login_failed` audit row with the reason, and the provider account's
issuer and subject when one came back.

## Routes

| Route                                                 | Who                                                   | What                                                           |
| ----------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/auth/oidc/config`                           | anyone                                                | `{ mode: 'off' }`, or `{ mode, label }` for the sign-in button |
| `GET /api/auth/oidc/start?return=<path>`              | anyone                                                | to the provider (a top-level navigation)                       |
| `GET /api/auth/oidc/callback`                         | the provider's redirect                               | signs a linked login in, or finishes a link                    |
| `GET /api/auth/oidc/status`                           | the signed-in login                                   | linked, the offer, whether it must link                        |
| `POST /api/auth/oidc/link` `{ password?, returnTo? }` | the signed-in login (cookie session), or a held login | `{ url }` to open                                              |
| `DELETE /api/auth/oidc/link`                          | the signed-in login                                   | removes its own link where it may                              |
| `POST /api/auth/oidc/offer`                           | the signed-in login                                   | hides the offer for 7 days                                     |
| `GET /api/users/oidc`                                 | the users area                                        | counts and each active login's link and outside mark           |
| `PATCH /api/users/:id/oidc` `{ outside }`             | the users area                                        | marks or clears an outside person                              |
| `DELETE /api/users/:id/oidc`                          | the users area                                        | removes a login's link                                         |

The types are in `packages/client-types/src/dto/auth.ts` (`OidcConfigDTO`,
`OidcStatusDTO`, `OidcRefusal`, `OidcAdminSummaryDTO` and the rest).

## Not in this milestone

- The client and phone screens (the button, the offer card, the link step,
  the profile and Users settings).
- A sign-in for a bearer client (the desktop app, the phone, the split web
  client): the system browser and a one-time code exchanged for a bearer.
- A first link inside the invite page: in required mode an invite accept
  makes the login and holds it at the link step (403-free: `linkRequired`),
  and the client takes it there.
- Fresh company sign-in (`max_age=0`) in place of the password at key
  creation and MCP consent.
- SCIM and the short lives of keys and MCP grants for leavers (Phase 5).
  Until then a block at the provider does not reach every way in: an API
  key or an MCP grant a person made (with the password they still know)
  lives on until an admin disables the login.
- An invite that marks the new login outside.
- A paired Telegram chat or a linked brain acting as a login is not ended
  by a block at the provider either (as keys and MCP grants, Phase 5); a
  company sign-in session cannot pair a chat.
- Links made under an earlier `MANTLE_OIDC_ISSUER` stay, unseen and unused,
  until the issuer is set back (an admin's unlink removes only the current
  issuer's).
- The one-click link right after a password sign-in (the 5-minute ticket)
  stands in for the password. Someone at that browser in those minutes can
  link their own company account; the person is told, and a sign out
  everywhere keeps the link, so an admin removes it.
- In required mode an unlinked login's password is its one link step (plan
  section 17.1). Someone who knows that password and holds an unlinked
  account at the provider can link it, and the real person's password is
  then refused (`sso-required`) until an admin removes the link. The link
  is audited with the provider account's subject and the name it shows
  (`auth.oidc_linked`; the link start too, `auth.oidc_link_started`), held
  starts share the login's failure budget, and the person is told. Holding
  a held link for an admin's approval is not in this milestone.
- In required mode a right password for a linked login answers 403
  `sso-required` where a wrong one answers 401: the password routes say
  whether a password is right (within their rate limits), as before the
  milestone a right one gave a session.
- A held ticket (5 minutes) is not ended by anything but its use or its
  time: someone at the same browser in those minutes can start the link.
- Required mode has no sign-in for a linked login on the phone, the desktop
  app or the split web client yet: keep `optional` until the client
  milestone ships (plan section 14).

## Testing

`server/web/lib/oidc/*.test.ts` (no database), `oidc-routes.db.test.ts`
(the app on Postgres, the provider stood in) and a round trip against a
local provider: `server/web/scripts/oidc-flow-check.ts`
(`pnpm -C server/web oidc:flow-check`; Keycloak or any OIDC test provider on
a loopback port). Never test with a production tenant.
