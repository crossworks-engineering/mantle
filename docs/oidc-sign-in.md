# Company sign-in (OIDC)

A box can let people sign in with their company account through any
OpenID Connect provider (Keycloak, Okta, Authentik, Entra ID and others).
It is off unless the operator turns it on in the box `.env`. Off, nothing
changes: the same sign-in screen, passwords only, the same one-year
session, and no call to any provider (corporate plan section 2.1; the
acceptance test is `server/web/lib/oidc/oidc-off.test.ts`).

Code: `server/web/lib/oidc/` (settings, provider, cookies, rules, store,
flow, handoff, exchange, fresh), the routes under
`server/web/app/api/auth/oidc/` and `server/web/app/api/users/oidc/`,
migrations `packages/db/migrations/0349_oidc_signin.sql` and
`0350_oidc_handoff_codes.sql`. A provider guide:
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
  `/api/auth/mobile-login`) refuse both cases with 403 and set no cookie. On
  `sso-link-required` they answer the held ticket in the body (`ticket`), and
  the client starts the link on it, handed to itself (see "Handing a sign-in
  to a client").

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

The box password rule (docs/policy.md) asks the same facts for its hold
(`credentialPasswordHold` in the same file): where the password is no way
in (required mode, a linked login) nothing holds a credential of that
login; an SSO session never meets the recheck it could not clear; and the
callback is open under every hold.

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
  started (one minute of clock skew allowed); an older one is refused. On
  the web app, a provider that sends no `auth_time` is let through, with one
  log line: the fresh sign-in was asked for, not proven. A link handed to the
  desktop app, the phone or a named origin must prove it.
- A login links itself, in its own session, with one click right after a
  password sign-in (the 5-minute ticket: a cookie on the same browser, used
  up when the link starts, or `oidcTicket` in a token login's answer), or
  later with its password typed again (5 tries in 15 minutes per login, each
  failure audited). A held login links on its held ticket.
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
(`buildSessionCookie`), or a device bearer (see below), with the life of
`MANTLE_OIDC_SESSION_HOURS`, marked (`so`) so a re-mint of it (a password
change) keeps the end it had and never becomes a year, whatever bearer
header rides along. Such a session cannot pair a phone or a Telegram chat, or
reset its own password with no old password (403 `sso-session`): each would be
a way in that outlives it. An API key
or an MCP grant can still be made from it, with a fresh sign-in (see "Fresh
sign-in"): those are credentials of their own, not sessions, so the session
gate does not judge them, and their leaver rules are Phase 5 (plan section
10.3). Refusing them would shut a person who signs in only with the company
account out of MCP clients. Sign out ends the Mantle session only (no single
logout).

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

## Handing a sign-in to a client

The web app, the desktop app and the phone all hold a bearer, and the
provider's sign-in runs in a browser, so the callback cannot give them a
cookie. They use one flow (`server/web/lib/oidc/handoff.ts`), PKCE between the
client and the brain, on top of the PKCE between the brain and the provider:

1. The client makes a verifier and keeps it. It opens, in the system browser,
   `GET /api/auth/oidc/start?redirect=<target>&challenge=<S256>`.
2. The provider signs the person in and comes back to the callback, as usual.
3. The callback sends the browser to the target with a one-time code, in the
   fragment: `<target>#oidc=code&code=<c>&purpose=signin&iss=<brain>`, or
   `<target>#oidc=<why it stopped>&iss=<brain>`. The client compares `iss` with
   the origin it connected to itself, never a value a brain told it, so a code
   from another brain is never sent here (a device can hold several). A client
   must connect to the brain's public URL, not an alias.
4. The client sends `POST /api/auth/oidc/exchange { code, verifier,
deviceName? }` and gets what the flow was for.

A code is 256 random bits, lasts 2 minutes and works once. Only its sha256 is
kept (`oidc_handoff_codes`). The verifier is compared after the code is spent,
so a wrong one burns the code. Every failure answers the same 401.

Targets, the only places a flow ends. Each is one exact URL, never an origin:
a brain serves mini apps and shared pages that run other people's script, and
any page that receives a code could send it on.

- `mantle://oidc`, the desktop app and the phone. Any app can claim a custom
  scheme and start a flow of its own, so a flow that ends here always asks the
  provider to sign the person in (`prompt=login`, `max_age=0`) and must prove
  it did (`auth_time` at or after the flow's start): a code is never handed
  over silently. A provider that sends no `auth_time` signs nobody in on the
  desktop app or the phone, and links nobody there, and each try ends with a
  bare `failed`. The first sign-in of any kind with no `auth_time` writes one
  log line, so read the log while a box is on `optional`, before `required`.
- `<origin>/auth/oidc`, the web app's own page, on this brain's public origin
  or `MANTLE_CLIENT_ORIGIN`. A client origin must be a named CORS entry too, or
  it cannot post the exchange.
- `<origin>/auth/oidc` on another named `MANTLE_API_CORS_ORIGINS` entry, under
  the same ask and proof as the app target: that list was made for bearer
  calls, not to receive sign-ins with nobody looking. Never the `*` wildcard.

The bearer is a device token like any other (listed and revoked in
Settings > Logins), with three differences. It lasts
`MANTLE_OIDC_SESSION_HOURS`. It carries the login's session epoch, so an
unlink ends it. It never rotates: `POST /api/auth/token/refresh` answers it
with itself until it ends, then the person signs in through the provider. The
gate judges it as a company sign-in session (`bearerSessionKind`,
`server/web/lib/oidc/hold.ts`), and the cookie `POST /api/auth/sso` upgrades it
to takes its end and its mark.

A link handed to a client (`POST /api/auth/oidc/link { handoff, ticket? }`)
answers a start URL for whichever browser opens it. The callback links
nothing: the link is made when the client spends the code. So a start URL
mailed to someone else links nobody's account to the sender's login: the
code reaches their app or browser, which holds no verifier.

## Fresh sign-in

Key creation and MCP consent ask a person to prove who they are again. A
login linked to a company account does that with a fresh company sign-in, in
place of its password (`server/web/lib/oidc/fresh.ts`). The provider signs the
person in again (`prompt=login`, `max_age=0`), the account that comes back must
be the one linked to this login (else `wrong-account`), and one code buys one
request, for the login and session epoch that asked. The ID token must say
when the person signed in (`auth_time`, at or after the flow's start). Unlike a
link, a fresh sign-in with no `auth_time` is refused: it stands in for a
password, so it must be proven. For Entra, add it as an optional claim
([oidc-entra.md](oidc-entra.md)).

- At key creation the client reads `GET /api/auth/oidc/status`: a `linked`
  login calls `POST /api/auth/oidc/fresh { redirect, challenge }`, opens `url`,
  and sends `fresh: { code, verifier }` on `POST /api/access-keys`. Where the
  status says `passwordConfirms` it may offer the password too. A failure
  answers 403 with `reason: 'fresh-sign-in'`.
- The MCP consent page is a page of this brain, so it needs no verifier: its
  **Confirm** button runs the flow in that browser and comes back to the page
  with a code, bound to that client, redirect, challenge, scope and resource,
  and spent by the same session on Allow.

In required mode a typed password does not confirm a login whose only way in
is company sign-in. In optional mode it still does (`passwordConfirms`), for an app
from before this milestone and for a provider that is down. The original
account keeps its password in every mode: it is the emergency admin. An
unlinked login confirms with its password.

## Routes

| Route                                                                    | Who                                  | What                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /api/auth/oidc/config`                                              | anyone                               | `{ mode: 'off' }`, or `{ mode, label }` for the sign-in button                                    |
| `GET /api/auth/oidc/start`                                               | anyone                               | to the provider (a top-level navigation): `?return=<path>`, `?redirect=&challenge=` or `?ticket=` |
| `GET /api/auth/oidc/callback`                                            | the provider's redirect              | signs a linked login in, or finishes a link                                                       |
| `GET /api/auth/oidc/status`                                              | the signed-in login                  | linked, the offer, whether it must link                                                           |
| `POST /api/auth/oidc/link` `{ password?, returnTo?, handoff?, ticket? }` | the signed-in login, or a held login | `{ url }` to open. With no `handoff`, a cookie session only                                       |
| `POST /api/auth/oidc/exchange` `{ code, verifier, deviceName? }`         | anyone with a code and its verifier  | a bearer, or a link made                                                                          |
| `POST /api/auth/oidc/fresh` `{ redirect, challenge }`                    | the signed-in login, linked          | `{ url }` to open                                                                                 |
| `DELETE /api/auth/oidc/link`                                             | the signed-in login                  | removes its own link where it may                                                                 |
| `POST /api/auth/oidc/offer`                                              | the signed-in login                  | hides the offer for 7 days                                                                        |
| `GET /api/users/oidc`                                                    | the users area                       | counts and each active login's link and outside mark                                              |
| `PATCH /api/users/:id/oidc` `{ outside }`                                | the users area                       | marks or clears an outside person                                                                 |
| `DELETE /api/users/:id/oidc`                                             | the users area                       | removes a login's link                                                                            |

The types are in `packages/client-types/src/dto/auth.ts` (`OidcConfigDTO`,
`OidcStatusDTO`, `OidcRefusal`, `OidcAdminSummaryDTO` and the rest).

## Not in this milestone

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
  time: someone at the same browser in those minutes can start the link. A
  ticket in a token login's answer is not used up by a link start either; it
  lives in the client's memory for those minutes.
- A person invited while the mode is on still chooses a password at the
  invite: a first sign-in with no password at all is not in this milestone.
- A password change from a company sign-in bearer ends that bearer (its epoch
  moves on): the person signs in with the provider again.
- A ticket in a token login's answer can start a link again within its 5
  minutes (held starts share the login's failure budget).
- A flow whose flow cookie is gone (another `start` overwrote it) ends on the
  brain's sign-in screen, not at the client.
- A consent page's fresh code rides the page's query string, so a proxy log
  in front of the brain can see it. It works once, for 2 minutes, for that
  login, session and consent.
- Required mode needs a client that has the company sign-in screens: keep
  `optional` until each client has shipped them (plan section 14).

## Testing

`server/web/lib/oidc/*.test.ts` (no database), `oidc-routes.db.test.ts`
(the app on Postgres, the provider stood in) and a round trip against a
local provider: `server/web/scripts/oidc-flow-check.ts`
(`pnpm -C server/web oidc:flow-check`; Keycloak or any OIDC test provider on
a loopback port). Never test with a production tenant.
