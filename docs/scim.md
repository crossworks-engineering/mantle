# SCIM user provisioning

SCIM 2.0 (RFC 7643, RFC 7644) is an open standard. With it, a company's
identity provider (Entra ID, Okta, OneLogin, or any SCIM client) tells a
box who may have access: it creates logins for the people it assigns, and
disables the login of a person it blocks or unassigns. A leaver then loses
Mantle access the same day, not when an admin remembers.

It is off unless the operator turns it on in the box `.env`. Off, every
SCIM route answers a plain 404, and nothing reads or writes the SCIM table
(corporate plan section 2.1; the acceptance test is
`server/web/lib/scim/scim-off.test.ts`). SCIM needs no particular provider
and works with company sign-in on or off ([oidc-sign-in.md](oidc-sign-in.md)).
A provider guide: [scim-entra.md](scim-entra.md).

Code: `server/web/lib/scim/` (settings, shapes, store, service, discovery),
the routes under `server/web/app/scim/v2/`, the users area's
`server/web/app/api/users/scim/route.ts` and
`server/web/app/api/users/[id]/left-behind/route.ts`, the report
`server/web/lib/leaver-report.ts`, migration
`packages/db/migrations/0359_scim_users.sql`.

## Why SCIM, and not company sign-in alone

Company sign-in alone does not stop a leaver. A block in the provider ends
their company sign-in when that session ends (`MANTLE_OIDC_SESSION_HOURS`,
12 hours by default), but an API key or an MCP grant they made lives on,
and so does a password where one still works, until Mantle hears of it.
SCIM is how Mantle hears of it: the provider's disable is the users area's
own disable, which ends every way in at once.

## Turn it on

1. Make a token, on the box or anywhere with the repo:

   ```bash
   pnpm -C server/web scim-token
   ```

   It writes a new token (256 random bits) once, to the terminal only, and
   the `.env` line that holds its sha256. Mantle keeps only the hash.

2. Add the line to the box `.env` and restart the app:

   ```bash
   MANTLE_SCIM_TOKEN_HASH=<64 hex characters>
   ```

   `docker-compose.yml` passes it to the app. A value that is not 64 hex
   characters is off, with one log line. On, the boot logs one line.

3. In the provider, set the SCIM URL (the tenant URL) to
   `MANTLE_PUBLIC_URL/scim/v2` and the secret token to the token from step
   1. Then clear the terminal.

The setting lives in the `.env` only (decision D2): a box admin cannot turn
it off, or read the token, from the app. To replace the token, run step 1
again, put the new hash in the `.env`, restart, and give the provider the new
token. The old one stops at the restart. To turn SCIM off, remove the line
and restart.

Without a token at hand, the same two values come from:

```bash
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
echo "$token"
printf '%s' "$token" | sha256sum
```

## What the provider can do

| Provider asks                                  | Mantle does                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create a user                                  | makes a **member** login with **no password** and **no workspace**. It reaches nothing until an admin adds it to a workspace. Never an admin, whatever the body says.  |
| find a user (`userName eq`, `externalId eq`)   | answers the login with that externalId, or the **enabled** login with that email (see "Matching people to logins")                                                     |
| set `active` to false (PATCH or PUT), DELETE   | the users area's disable (below), first, before anything else the request asks. DELETE removes nothing.                                                                |
| set `active` to true                           | enables the login again, only if the provider itself disabled it and it is not an Admin user. Otherwise the login stays disabled, and the audit row says `enableKept`. |
| change `displayName` (or `name.formatted`)     | renames the login, unless it is an Admin user (whose name reaches the prompts): the audit row says `renameKept`                                                        |
| set `externalId`                               | keeps the provider's id for the person, once. A different one later, or removing it, is a 409 `mutability`: the id names the person.                                   |
| change `userName`                              | accepted and left as it was: a login keeps the email it was made with (the Users screen cannot change one either). The audit row says `userNameKept`.                  |
| PUT with no `active`                           | leaves the login active or disabled as it is                                                                                                                           |
| anything else (emails, name parts, title, ...) | accepted and left alone                                                                                                                                                |

A disable is the same one an admin makes (`server/web/lib/login-update.ts`
`applyLoginChange`): every session, device bearer, API key, MCP grant,
linked peer and open pairing code of the login ends; its push devices go;
its personal assistant is released (kept). The login, its links and
everything it made stay.

A disable comes first in every request. An attribute the brain cannot
read, a refused externalId or an operation it does not know is answered as
a SCIM error after the disable is done, so nothing else a provider sends in
the same request can keep a leaver in.

The provider undoes only its own disable (`scim_users.scim_disabled_at`,
the login's `disabled_at` when the provider disabled it). A login an admin
disabled stays disabled whatever the provider sends, and so does any Admin
user the provider disabled: an admin enables those by hand, on the Users
screen.

Every change writes the users area's own audit row (`user.create`,
`user.update`) with `scim` as the actor and `via: 'scim'` in its detail.
The rows a disable writes for the keys and linked peers it ended
(`key.revoked`, `peer.unbound`, as on the Users screen) carry
`session-end` and the brain's own id as their actor: read them beside the
`scim` row of the same moment.

### What SCIM never touches

- **The original account** (the emergency admin): never listed, never
  found, never changed (404). Do not assign it in the provider. Keep its
  password in the company's vault.
- A login with a role this code does not know.
- Groups: there is no `/Groups` route. Turn group provisioning off in the
  provider; give people access with workspaces, in Mantle.
- Admin rights: SCIM creates members only, and never adds anyone to a
  workspace. An admin is made in **Settings > Workspaces > Admin**.

### A login SCIM made, signing in

It has no password. With company sign-in on, a person links a company
account to a login in that login's own session (never by email,
[oidc-sign-in.md](oidc-sign-in.md)), so the first sign-in needs a
password: an admin sets one (**Reset password**), the person signs in with
it once and links, and then signs in with the company account. In required
mode that first password sign-in leads straight to the link step.

## Matching people to logins

The provider names a login by its SCIM `id`, which is the login's id. Before
it creates anyone, a provider asks for the person by `userName` (the email):
a login made by hand is found that way (plan section 9.3: the one match on a
name, allowed because the box operator gave the provider the token). The
first write the provider makes to a login marks it as the provider's
(`scim_users`), with its `externalId`.

An email finds an **enabled** login only. A leaver is disabled, so an
address the company hands on to a new person never finds the leaver's
login: the new person's create answers 409 (the email is taken), and an
admin decides what to do. A disabled login is found by its id or its
externalId, never by its email.

The plain list (`GET /Users` with no filter, what Okta's Import Users
reads) holds enabled logins only, by the same rule, so an import never
matches a new person to a leaver's login either.

A rehire, or a person the provider assigns again after a leave, is not
found by email (the login is disabled), so the provider's create answers
409: an admin enables the old login by hand, or decides on a new one. This
fails closed: no leaver is ever left enabled by it.

A disable or an enable checks the login again under its row lock, in the
change's own transaction: an admin's change made while the provider's
request runs always wins (the provider's disable then records nothing as
its own, and its enable leaves the login as the admin left it).

The externalId never changes once set. Map the provider's immutable id to
externalId before the first sync (for Entra, `objectId`), and make
externalId a matching attribute too: a provider that starts its sync again
finds its active people by email and its disabled ones by externalId.

On a box with no original account yet, every Users route answers 503: a
provider's first sync never makes the box's first login.

A read never marks a login. The users area's status (`GET /api/users/scim`)
counts the logins the provider manages, the disabled ones, and the enabled
ones it gave no externalId (`noExternalId`: those are found only by their
email if the provider ever matches again, so map an externalId).

Never let a sign-in link a company account through `scim_users.external_id`:
the provider may match a login by email once, so a link made from it would
be a link by email ([oidc-sign-in.md](oidc-sign-in.md), "Links").

## The routes

All under `MANTLE_PUBLIC_URL/scim/v2`, each answering
`application/scim+json`, `Cache-Control: no-store`. Every route takes the
bearer token (`Authorization: Bearer <token>`); a missing or wrong one is a
SCIM 401. Off, every route is a plain 404 `{ "error": "not found" }`.

| Route                                | What                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET /Users`                         | a page of logins (`startIndex`, `count` up to 200), or the one a filter names      |
| `POST /Users`                        | create (201, `Location`); a userName or externalId in use is a 409 `uniqueness`    |
| `GET /Users/:id`                     | one login; not a login SCIM may see is a 404                                       |
| `PATCH /Users/:id`                   | a PatchOp: `add`, `replace`, `remove`, in any case, with or without a path         |
| `PUT /Users/:id`                     | a whole User (Okta): `active` (absent: left as it is), `displayName`, `externalId` |
| `DELETE /Users/:id`                  | a disable (204); nothing is removed, and the login reads as inactive after         |
| `GET /ServiceProviderConfig`         | PATCH and filter supported; no bulk, sort, ETag or password change                 |
| `GET /ResourceTypes`, `GET /Schemas` | one resource type, User                                                            |

Filters: `userName eq "…"`, `externalId eq "…"` and `id eq "…"` only. Any
other filter is a 400 `invalidFilter`, never a list of everyone. The
shapes Entra and Okta send are read as they come: `Replace` or `replace`,
`"False"` or `false`, a path with the core schema's URN in front, and an
operation with no path whose value is an object.

Rate limit: 600 requests a minute per address (`scim` in
`server/web/lib/route-limits.ts`), a machine's 429 with `Retry-After`. A
first sync of thousands of people stays under it at one or two calls each
per second. The limit is taken before the token is read, so a box with
SCIM off answers 429 under a flood as well.

The front door routes `/scim` to the server app in both Caddy shapes
(`infra/caddy/shapes/same-origin.caddy`).

## Leavers: what a login leaves behind

A disable ends what the login could do. It removes nothing it made: its
tasks, agents, private items and comments stay, and so do the share links
of its items. An open share link keeps working after the disable (decision
D7: a share link is often a business record). An admin decides what to keep
or revoke from the report:

`GET /api/users/:id/left-behind` (the users area; served while company
sign-in or SCIM is on, else 404; for a disabled login only, else 409: a
login still in use is its own) answers:

- `live`: the API keys, MCP grants and device bearers that can still act as
  the login (each 0 after a disable);
- `privateItems`: the items whose home is the login's private workspace, by
  type;
- `shares`: the live share links (open links and contact shares) of those
  items, with their views (the first 500; `sharesTruncated` says when there
  are more);
- `moderates`: the workspaces the login moderates, and whether it was the
  only Moderator there (an Admin user should name another);
- `ownRows`: its own chats and what was learned from them;
- `login.scim`: whether the provider manages the login, and its externalId.

A share link of an item whose home is another workspace belongs to that
workspace, not to the person, and is not listed.

The Mantle disable covers one box. Each box needs its own SCIM app (or its
own app assignment) in the provider, or a person stays active on the
others.

## Tests

- `server/web/lib/scim/scim-shapes.test.ts`: the shapes and the token gate.
- `server/web/lib/scim/scim-off.test.ts`: off, every route answers 404 and
  reads nothing; on, a wrong token reads nothing.
- `server/web/lib/scim/scim-routes.db.test.ts`: through the app on a real
  database: create, the filter, the disable ending sessions, keys and
  grants, DELETE keeping data, an Admin user, the original account out of
  reach, the report and the rate limit.
