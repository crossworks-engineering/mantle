# Client logins (removed)

There is no client login any more. Workspaces W5c removed the client portal
and the admin-issued sign-in links; workspaces W8a (owner decision
2026-10-11) removed the client login role itself and the email-code
sign-in. A login is an admin or a member row, and it carries no permission
of its own: what it reads and may do comes from its workspaces. A person
outside the team who needs to see something gets it the same way as anyone
else: as a user of a workspace that holds it.

## What went in W8a

- The `client` login role. The role CHECK on `auth.users` admits `admin` and
  `member` only. A login row that says anything else is no login at all: it
  signs in by no path (cookie, device token, API key, OAuth grant or peer),
  and every gate answers it as a stranger (`server/web/server/role-sweep.test.ts`).
- Email-code sign-in. `GET`/`POST /api/auth/client-code`,
  `POST /api/auth/client-code/verify`,
  `GET`/`PUT /api/team-admin/clients/signin-sender` and its `preview` answer
  410 `{ error, code: 'gone' }` before any work. The sign-in code queue
  (`mantle.client.code`) has no worker, and the nightly code reaper is gone.
- Every role fence that came with the client: the client session and
  device lifetimes, the client gate, the routes closed to a client, the
  client branch of the MCP surface, and the role a key or a peer kept from
  when it was made. A key and a peer act as their login as it is now.
- `MANTLE_CLIENT_SPACES_TOTAL_BYTES` (the client spaces took no write since
  W6b).

The old `/api/client/*` routes stay as stubs that answer every signed-in
login 410 code gone, so an old app can say "update".

## Migration 0272

Every client login was archived, then ended as an admin's End sessions and
Disable end a login, and kept as a disabled member row (its writing keeps
its author):

- `archive_client_logins`: its auth row as it was (no password hash);
- disabled, its session epoch bumped; its device tokens, API keys and OAuth
  grants revoked, its OAuth codes and push devices deleted; the peers bound
  to it unbound and switched off, with their Write off and their risky tools
  cleared. Nobody was added to a workspace and no notify fired.

A former client stays one (`archive_client_logins` is the list):

- On a brain already on workspaces, each workspace row a client login held
  was archived (`archive_client_workspace_users`) and removed, with a
  workspace event `former_client.removed` each, so nothing is granted again
  by itself.
- A brain not on workspaces yet that had a client login (even one deleted
  since) reports "clients present" and is never switched at boot (plan
  21.9). After the hand setup, the switch is run by hand in one
  transaction: `SET LOCAL mantle.ws_former_clients = 'reviewed'`, then
  `select * from mantle_ws_migrate_locked()`.
- The login bridge (`mantle_bridge_login`) gives a former client no role:
  no switch, role change or invite puts one in Admin or Team.
- Nor in a private workspace: the review homes, the spaces fold of a
  switch and `mantle_ws_private_workspace` treat a former client as a
  login that is gone. Its items go to its "Former user" workspace (no
  users; an Admin user may join it), as a deleted login's do. A private
  workspace a former client already had loses its `private_workspaces` row
  (archived first, `archive_client_private_workspaces`), so the next
  review homes run renames it "Former user" and registers it.
- An admin cannot enable a former client login again
  (`PATCH /api/users/:id` with `disabled: false` answers 409), and an
  invite or a new login on a former client's email is refused (409,
  `reason: 'email-was-client'`), or linked to its contact (409,
  `reason: 'contact-was-client'`); an invite made before redeems nothing.
  Linking another login to a former client's contact with
  `PATCH /api/users/:id` is refused the same way (409,
  `reason: 'contact-was-client'`).
- What a former client wrote stays client-sourced: its login id (its old
  chat thread), an item it wrote, and a workspace it is a user of count for
  the client-sourced write hold (`packages/tools/src/client-sourced.ts`).

The email-code tables (`client_signin_codes`, `client_signin_code_skips`,
`client_signin_sender_folders`) and the retired static login tokens
(`mcp_login_tokens`) were archived as metadata only (never a code, a token
hash, a request id or an address) into `archive_client_signin_codes`,
`archive_client_signin_code_skips`, `archive_client_signin_sender_folders`
and `archive_mcp_login_tokens`, then dropped. The role a key or a peer was
made under went to `archive_key_roles` and `archive_peer_roles` before its
column was dropped; a key or a peer the old role check was refusing (its
login's role changed after) was ended first, so none came back to life.
Every archive is counted against what it copied (a mismatch rolls the
migration back); every drop is RESTRICT; a second run changes nothing.

The sent-mail folders a sign-in sender choice had left out of mail sync stay
left out (`email_accounts.imap_excluded_folders`); an admin can include them
again in the account's folder settings.

## What stays

- Old code mails never enter the brain. Every code mail carried a marker in
  its Message-ID (and an `X-Mantle-Client-Code` header); the mail sync skips
  a message with it, or a reply or forward of one, before anything is
  fetched or stored (`packages/email/src/client-code-mail.ts`, `ingestOne`
  in `packages/email/src/sync.ts`). Sign-in codes in links are blanked in
  everything stored.
- The client-sourced write hold and its marks (`client_sourced_nodes`), the
  client comment ledger and the client level columns: those are W8c and W10
  work, not the login's.

## What went in W8d

Migration 0274 archived, then dropped, the client tables nothing reads any
more: `client_report_acks` (What clients see) into
`archive_client_report_acks` and `client_quota_refusals` (the client quota
log) into `archive_client_quota_refusals`, each counted, each drop RESTRICT.
The client code that read them, the client reader of drawings and accepted
items, and the client branch of the app data tools are gone.
