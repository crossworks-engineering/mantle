# Member logins (replaced by workspaces)

A login no longer has a tier. Users are flat: a login carries no
permission of its own, and what a user reads and may change comes from
the workspaces they are in. Read [workspaces.md](./workspaces.md).

What changed for the people this page used to describe:

- **A member** is a login that is not a user of the Admin workspace. They
  read what their workspaces hold, chat with each workspace's assistant in
  their own thread, use the one MCP surface
  ([mcp-as-a-login.md](./mcp-as-a-login.md)), and make API keys of their
  own.
- **Personal spaces** were folded into a private workspace per user
  (workspaces W6b, migration 0267). Their items are brain items homed
  there.
- **Review, submit, accept, take over, team drafts and the member chat
  routes** are removed (W5c and W7c). The removed routes answer 410
  `{ error, code: 'gone' }`.
- **Client logins** are removed (W8a): [client-logins.md](./client-logins.md).

What this page said about the member role, personal spaces and review is
in the repository history before workspaces W8f. The facts below still
hold.

## Logins and sessions

- `auth.users.role` is `admin` or `member`. Adding a user to the Admin
  workspace makes the row an admin, and removing them makes it a member;
  the role grants nothing by itself. The anchor (`is_owner`) is always an
  admin. The column has no default (migration 0190): every insert names the
  role.
- Every active login's email counts in both email gates (inbound and the
  send tools), next to the contact list. A disabled login's address does
  not.
- **Sessions end** (migration 0181). The session cookie and the `?at=`
  asset token carry the login's `session_epoch`, and every request compares
  it with the row. A password change, an admin password reset, disable (and
  enable again), a role change and **Sign out everywhere** bump it and
  revoke the login's bearers and API keys.
- **Disabled.** `auth.users.disabled_at` set: the login cannot sign in,
  refresh a bearer or use a session it holds.

## Invites

An admin (users area) invites a person in **Settings > Logins > Invite**.
The person opens the link, sets a password, and is a member login. The
table is `member_invites` (migration 0174); the logic is
`packages/content/src/member-invites.ts`.

- The code is 16 characters (about 92 bits). Only its SHA-256 is stored;
  the plaintext is in the create answer once. It lives 72 hours and
  redeems once. A new invite for the same contact or email replaces the
  old one.
- The link carries the code in the fragment (`/invite#code=...`), so it
  lands in no access log and no Referer header.
- `GET /api/auth/invite/:code` previews; `POST /api/auth/invite/accept`
  redeems. Every failure is the same 401. Both are rate limited per IP and
  for the whole brain on failed codes only.
- An invite on the email of a former client login is refused (W8a).
- The new login joins the Team workspace as a Moderator (plan Q1), in the
  same transaction as the redeem. Add them to any other workspace they
  should reach on the workspace screen. Their private workspace comes the
  first time it is needed.

## External access: outside tools in shared apps

A site adds its own outside tools: an MCP connector or an http API, for
example a read-only SQL bridge to a site database. The brain cannot judge
what such a tool does, so an admin decides per tool with the switch
**External access** on the tool row (`packages/tools/src/external-access.ts`).

- **Which tools.** MCP and http tools only. An http tool must not send PUT,
  PATCH or DELETE. Never a recipe or a shell tool, and never a tool that
  needs a confirmation (nobody is there to confirm in an app loop).
  Built-ins need no switch.
- **Who switches it on.** Only an admin, in Settings > Tools on the tool
  (`PUT /api/tools/:id/external-access` `{ allow, readOnlyConfirmed }`) or
  through `api_tool_update` from the owner's own MCP client. The read-only
  confirmation is required: the row keeps when, which admin, and a sha256
  signature of the handler the admin looked at (`tools.external_access`,
  migrations 0215 and 0225). An in-brain agent may switch it off, never on.
- **Who may call it.** The app's sharing decides: a user who runs an app
  granted to one of their workspaces, and a contact on a contact-share link
  who passed the code. Never an open link. The app must declare the tool.
  Everyone the app reaches can call the tool by hand with any input, not
  only what the app's screens send; for a tool that takes free SQL, they
  can read anything the connector can read.
- **Off.** Switching off refuses the next call. A changed handler, or a
  connector moved to another server or credential, voids the switch.
- **Audit.** Every call, allowed or refused, lands in the app's access log
  with the login, or the contact and the share.

An MCP connector's own tools reach users through the workspaces it is a
resource of, with the connector's read-only mark per tool
([mcp-as-a-login.md](./mcp-as-a-login.md), "Connector tools").

## Files, deleting and rollback

**Where the bytes live.** The bytes of files folded from a personal space
sit under `MANTLE_SPACES_ROOT/<spaceId>/files/<nodeId>`: its own bind
mount (`/data/spaces` in docker-compose.yml), outside the brain's files
tree. `scripts/db-dump.sh` and the scheduled backup tar the root to
`backups/mantle-spaces-<ts>.tgz`; `scripts/db-restore.sh` puts it back
with the dump. Four services carry `MANTLE_SPACES_ROOT`: web, api, the
events worker (which runs the scheduled backup, read-only mount) and the
maintenance worker; a production process without it answers an upload
there 503 instead of writing into the container.

**Deleting a login** moves its private items to a "Former user" workspace
with no users; an Admin user may join it. The `space-purge` maintenance
task was retired in W6b and removed in W8d: nothing is purged.

**Rollback.** Once personal items exist, never roll back below
v0.232.255 (the extractor's owner check). Once migration 0178 ran (it
drops `contact_team_tokens`), never roll back below v0.232.301: v0.232.300
still reads that table for invite redeem and the Team admin Members tab,
and both fail. The pre-roll backup (`backups/pre-roll/`, taken by the
updater before every server roll) is the only way back past 0178.
