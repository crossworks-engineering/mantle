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

| Provider asks                                  | Mantle does                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create a user                                  | makes a **member** login with **no password** and **no workspace**. It reaches nothing until an admin adds it to a workspace. Never an admin, whatever the body says. |
| find a user (`userName eq`, `externalId eq`)   | answers the login with that email or that externalId                                                                                                                  |
| set `active` to false (PATCH or PUT), DELETE   | the users area's disable (below). DELETE removes nothing.                                                                                                             |
| set `active` to true                           | enables the login again (as **Enable** on the Users screen)                                                                                                           |
| change `displayName` (or `name.formatted`)     | renames the login                                                                                                                                                     |
| change `externalId`                            | keeps the provider's id for the person                                                                                                                                |
| change `userName`                              | accepted and left as it was: a login keeps the email it was made with (the Users screen cannot change one either). The audit row says `userNameKept`.                 |
| anything else (emails, name parts, title, ...) | accepted and left alone                                                                                                                                               |

A disable is the same one an admin makes (`server/web/lib/login-update.ts`
`applyLoginChange`): every session, device bearer, API key, MCP grant,
linked peer and open pairing code of the login ends; its push devices go;
its personal assistant is released (kept). The login, its links and
everything it made stay, and an admin may enable it again. A login an admin
disabled by hand is enabled again if the provider later sets it active, so
disable a person in the provider, not in Mantle, while SCIM is on.

Every change writes the users area's own audit row (`user.create`,
`user.update`) with `scim` as the actor and `via: 'scim'` in its detail.

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
a login made by hand is found that way once (plan section 9.3: the one
match on a name, allowed because the box operator gave the provider the
token). The first write the provider makes to a login marks it as the
provider's (`scim_users`), with its `externalId`. After that the provider
uses the id, so a later email change on its side moves nothing.

A read never marks a login. The users area's status (`GET /api/users/scim`)
counts the logins the provider manages.

## The routes

All under `MANTLE_PUBLIC_URL/scim/v2`, each answering
`application/scim+json`, `Cache-Control: no-store`. Every route takes the
bearer token (`Authorization: Bearer <token>`); a missing or wrong one is a
SCIM 401. Off, every route is a plain 404 `{ "error": "not found" }`.

| Route                                | What                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /Users`                         | a page of logins (`startIndex`, `count` up to 200), or the one a filter names   |
| `POST /Users`                        | create (201, `Location`); a userName or externalId in use is a 409 `uniqueness` |
| `GET /Users/:id`                     | one login; not a login SCIM may see is a 404                                    |
| `PATCH /Users/:id`                   | a PatchOp: `add`, `replace`, `remove`, in any case, with or without a path      |
| `PUT /Users/:id`                     | a whole User (Okta): `active`, `displayName`, `externalId`                      |
| `DELETE /Users/:id`                  | a disable (204); nothing is removed, and the login reads as inactive after      |
| `GET /ServiceProviderConfig`         | PATCH and filter supported; no bulk, sort, ETag or password change              |
| `GET /ResourceTypes`, `GET /Schemas` | one resource type, User                                                         |

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
sign-in or SCIM is on, else 404) answers:

- `live`: the API keys, MCP grants and device bearers that can still act as
  the login (each 0 after a disable);
- `privateItems`: the items whose home is the login's private workspace, by
  type;
- `shares`: the live share links (open links and contact shares) of those
  items, with their views;
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
