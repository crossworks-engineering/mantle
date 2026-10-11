# Client logins

> **Update 2026-10-11 (workspaces W5c): the client portal and the sign-in
> links are removed.** A client login now uses the one (app) shell, like a
> member: `GET /api/shell` answers every login with the same shape (`role`
> says which; see member-logins.md and
> [mobile-companion-backend.md](./mobile-companion-backend.md)). Removed,
> each answering 410 `{ error, code: 'gone' }`:
>
> - every `/api/client/*` route (the old client shell, "Shared with you",
>   the client tree, bytes, chat, push, the client's own space, My requests,
>   accepted items, client apps);
> - `POST /api/auth/client-link` (admin-issued sign-in links);
> - `GET`/`POST /api/team-admin/clients`, `POST`/`DELETE
/api/team-admin/clients/:id/signin-link`,
>   `GET /api/team-admin/clients/storage` and `.../usage`;
> - `GET /api/access/client-report` and its `POST .../ack` (What clients
>   see).
>
> **Kept:** email sign-in codes (section 3), the sign-in sender
> (`/api/team-admin/clients/signin-sender` and its preview), client sessions
> and device tokens (section 4), and End sessions, Disable and Delete on
> `/api/users/:id`. The client chat agent (`client-responder`) and its
> `client-read` group no longer ship; existing rows stay, with the group and
> its tools disabled. Clients are not migrated to workspaces (plan 21.9): a
> box with client logins is not switched. A client's personal space rows and
> files stay in the database until W6b; only the routes went. Sections 2, 5,
> 8, 9 and 10 below describe what was removed, briefly.

> **Update 2026-10-09: the admin screens moved.** Team admin > Clients, What
> clients see and Member chats (the client filter) are now in Settings >
> Logins: a Clients section whose first step is What clients see, then Client
> settings (sign-in sender, chat use, storage), then the client logins (each
> with its Sign-in link card and a Chat view). The brain routes and their
> admin-only gates are unchanged; "Team admin > Clients" below means that
> section.

> **Update 2026-10-09: comments are removed.** The client thread on
> client-level items, the review talk in a client's space, the comment caps
> and ledger code, Team admin > Clients' comment card and its delete action,
> and comment pushes are gone. User-to-user talk moves to the forum (dev-brain
> plan Forum v2). The `node_comments` and `client_comment_ledger` tables and
> their rows stay; deleting a client login still removes the comments it wrote
> before.

> Client logins, phases C0 to C6 and the audit fixes of C2 to C5. The
> operator's guide: what a client login is, how an admin lets a client in,
> how emailed codes work, what a client reads and writes, and what bounds
> it. What a client may read is decided by Postgres row security at the
> client level ([access-levels.md](./access-levels.md)); the role checks
> every route makes are in [member-logins.md](./member-logins.md) section 2,
> and what members and admins see of clients is its section 14. The
> security summary is [security.md](./security.md) section 5a.

**Contents.**

1. **What a client login is**: role client, no password, a browser session
   or the phone app's device token, the one shell.
2. **Making and ending a client login**: Team admin > Clients is gone (W5c);
   End sessions, Disable and Delete stay.
3. **Email sign-in codes**: the sign-in sender, the email worker, the card,
   how a code works, its caps and upkeep.
4. **Sessions**: 30 days, sign out ends every session, 10-minute asset
   tokens.
5. **What a client reads**: the portal reads are gone (W5c).
6. **One origin**: the client pages need the same-origin Caddy shape.
7. **Operations**: restore, Caddy, the auth POST guard, mail sync, the
   rollback floor.
8. **Client chat, drafts, requests and apps**: removed in W5c.

## 1. What a client login is

- **A person at the brain's one client company.** `auth.users.role` is
  `client` (migration 0187). A brain serves one client company; two
  companies are two brains.
- **No password.** A client login has a password hash nobody knows, so no
  password opens it. Password sign-in, the mobile and bearer logins,
  `POST /api/auth/change-password`, a personal assistant and MCP consent
  all refuse a client. An admin password reset on a client answers 400
  `not-a-password-login`. A client signs in with a code the brain emails
  (section 3). Code sign-in stays for client logins only: a login's
  password hash carries no mark of "no usable password", so a member or an
  admin (who has a password) never gets a code, which keeps their sign-in
  as strong as their password.
- **A browser, or the phone app.** In a browser the session is a cookie on
  the brain's origin (section 6). The phone app holds a device token (a
  bearer): the emailed code in device mode answers one instead of a cookie
  (section 4, and mobile-companion-backend.md "Three roles on the phone").
  Nothing else mints a client bearer: no password sign-in, no web-client
  token login, no QR pairing.
- **Deny by default, one shell.** A client reaches `GET /api/shell` and the
  other routes every login reaches (`server/web/lib/auth/any-login-routes.ts`:
  its workspaces, its access keys, Grant Access where a workspace lets it).
  The routes in `CLIENT_ROUTES` (`server/web/lib/auth/client-routes.ts`) are
  the old portal's: each answers a client 410 code gone since W5c. Every
  admin and member gate refuses a client with 403 `client-login`;
  `server/web/server/client-sweep.test.ts` and `role-sweep.test.ts` drive
  every route of the manifest with a client session to prove it.
- **A client stays a client.** `PATCH /api/users/:id` refuses a role change
  to or from client. To make a client a member, disable the login and
  invite the person as a member.

## 2. Making and ending a client login

Removed in W5c: acknowledging "What clients see", Add client, Issue and
Revoke sign-in link, and the client list, storage and chat use cards (the
routes answer 410). No route makes a client login any more.

What stays, on `/api/users/:id` (admin only):

- **End sessions** (`PATCH` `{ "signOut": true }`) and **Disable**
  (`{ "disabled": true }`) end every session the client holds and, in the
  same transaction, revoke its open emailed codes (and any sign-in link
  left from before W5c). A code issued before a disable does not work
  after Enable.
- **Delete** (`DELETE`) removes the login. Its codes go with it (foreign
  key cascade), and so does its chat thread. In the same transaction every
  comment the client wrote before comments were removed is deleted; the
  answer says how many: `{ ok: true, commentsDeleted }`.
- A client stays a client: `PATCH /api/users/:id` refuses a role change to
  or from client.

The sign-ins write their own audit rows (`auth.client_code_signin` and its
`_failed` twin; `auth.client_link_signin` rows from before W5c stay).

## 3. Email sign-in codes

Codes are **off** until an admin picks a sign-in sender. Then a client
types their email on the sign-in page, gets an 8-digit code by mail, and
types it in the same browser.

### Picking a sign-in sender

Team admin > Clients > Send codes from
(`GET` and `PUT /api/team-admin/clients/signin-sender`).

- **Which accounts.** The brain's own email accounts that are enabled,
  IMAP, and can send (SMTP set up; the send reuses the IMAP app password,
  [email-send.md](./email-send.md)). Any other account is refused with 400
  `account-cannot-send`.
- **Its Sent folders leave mail sync.** Choosing a sender leaves its
  sent-mail folders out of mail sync, so the brain never ingests its own
  copies of the code mails (a code in the corpus is a code the agents can
  read and repeat). Before the admin confirms, the preview
  (`GET /api/team-admin/clients/signin-sender/preview?accountId=`) names the
  folders that will be left out, and writes nothing. The sent folders are
  the ones the server flags `\Sent`, else the usual names (Sent, Sent Items,
  Sent Mail, Sent Messages).
- **Refused, with nothing saved,** when no sent folder is found (409
  `no-sent-folder`) or the folders cannot be listed (409
  `folders-unreadable`).
- **Choosing None or another sender puts them back.** The brain records
  exactly which folders it added (migration 0193), and restores those. None
  turns codes off.

### Codes need the email worker

The sign-in route only queues a request; the email-sync worker makes and
mails the code. `GET /api/auth/client-code` answers whether codes are on:
a sender is chosen **and** an email worker finished a job in the last 10
minutes. A brain-core box (`install.sh --core`) leaves the email worker
out, so codes are off there whatever the sender, and a client cannot sign
in there.

### The card

The Send codes from card shows:

- **delivered** and **failed**: code mails of the last 24 hours the mail
  server took, and the ones that failed;
- **last failure**: the newest failed send, a short reason (never the
  code);
- **cap skips**: requests of the last 24 hours skipped at a send cap. Many
  of them means someone is using up a client's codes;
- the day's count against the brain-wide cap, and a banner when it is
  reached (requests still answer 200; nothing is sent);
- **email worker**: whether an email worker serves the code queue on this
  box. Off means codes are off.

### How a code works

- **The request** (`POST /api/auth/client-code` `{ email }`) always answers
  200 `{ ok: true }` and sets a request cookie (15 minutes, SameSite
  strict, sent only to the code routes). It only queues the request; the
  worker looks the email up, applies the caps, stores the code and mails
  it. So neither the answer nor its timing tells whether an email is a
  client. With no sender, nothing is queued. The queued job carries the
  email and the request id, never a code, and is kept briefly (dropped if
  not worked within an hour, deleted a day after it finishes).
- **A code** is 8 digits, lives **10 minutes**, works **once** and allows
  **5 wrong tries**. It belongs to the browser that asked: a code forwarded
  to another browser opens nothing. Asking again from the same browser
  while its code is open sends no second mail; the code already mailed
  keeps working.
- **Stored as an HMAC.** Only HMAC-SHA256 of the request id and the code is
  stored, keyed from `SESSION_SECRET`. A copy of the database alone recovers
  no code. Changing `SESSION_SECRET` kills the open codes.
- **The mail** is a plain SMTP send from the sender: no agent, no model, no
  contact gate. It carries a marker in its Message-ID and an
  `X-Mantle-Client-Code` header, which mail sync skips (security.md).
- **The verify** (`POST /api/auth/client-code/verify` `{ email, code }`)
  answers the same 401 for every failure, after the same work on every
  branch, so the timing does not tell whether an email is a client.

### Caps

Send caps, applied by the worker (a capped request sends nothing and counts
as a cap skip):

- **3 an hour and 5 a day per email plus address.** A stranger's addresses
  never use up a client's own address.
- **20 a day per login**, from all addresses together, except from an
  address that client signed in from with a code before: strangers cannot
  lock a client out of its usual address. The per email plus address caps
  still apply there.
- **200 a day for the whole brain**, failed sends included.
- No new code while one is open for the same email and address.

Route caps, per address: a code request 10 a minute, a verify 30 a minute
and 5 failed verifies per email plus address in 10 minutes. An address is
an IPv4 address, or the /64 of an IPv6 one, so one IPv6 client cannot rotate
through its own block.

There is **no brain-wide failure lockout** on codes: a stranger with many
addresses cannot hold every client out.

### Upkeep

The `client-codes-reap` maintenance sweep (nightly, plain SQL, no model;
[maintenance-runner.md](./maintenance-runner.md)) deletes finished code
rows older than 30 days (a used sign-in link is kept, as the admin's "last
used" record), blanks the request address on code rows older than 7 days,
and deletes cap skip rows older than 30 days. By hand:
`pnpm -C server/web client-codes:reap` counts, and `--apply` writes. The
rule is `reapClientSigninCodes` in `packages/content/src/client-codes.ts`.

## 4. Sessions

- **30 days.** A client session lasts 30 days, not a year. A client cookie
  that claims a later expiry is refused. Like every session it carries the
  login's session epoch (member-logins.md section 1).
- **Sign out ends every session.** A client's plain Sign out ends all its
  sessions and asset tokens, not only this browser's: a client is often on
  a shared computer, and a download URL left in its history must stop
  working. It does not revoke an emailed code the client has not used yet:
  End sessions and Disable do (section 2).
- **The phone app's device token** (migration mobile_roles_push). `POST
/api/auth/client-code/verify` with the request id in the body (device
  mode) answers a bearer and sets no cookie. It is a `mobile_tokens` row
  under the client login (listed and revoked in Team admin like every
  device), lasts 30 days, and carries the login's session epoch: the session
  layer refuses it once the epoch moves on, exactly as it refuses the
  cookie, and refuses a client token with no epoch or one that claims more
  than 30 days. `POST /api/auth/token/refresh` rotates it (each new token at
  most 30 days, at the same epoch). The client's sign-out, in the browser or
  on the phone (`POST /api/auth/mobile-logout`), ends every session and
  token of the login; End sessions and Disable do too. A client token
  reaches the one shell and the any-login routes, and the old
  `CLIENT_ROUTES` answer it 410: `role-sweep.test.ts` drives every manifest
  route with one.
- **90 days from the code, then a new code.** Refresh keeps a client's
  device token alive for at most 90 days from the emailed code that signed
  the phone in (`mobile_tokens.signed_in_at`, copied through every
  rotation). After that, refresh answers 401 with
  `reason: "sign-in-expired"` and the app asks for a new code. A browser
  session has no refresh: it ends after 30 days.
- **Refresh rules (every role).** While more than 23 days remain, refresh
  answers the SAME token and writes nothing. A retry with a rotated token
  whose successor was never used (the answer was lost) gets that same
  successor again. A rotated token presented again after its successor WAS
  used is a copy in someone else's hands: on a refresh or on any route, the
  brain ends every session of the login once, removes its push devices and
  writes the audit row `auth.token_reuse`; the same old token later is a
  plain 401. The refresh locks the login row, so it cannot outlive End
  sessions.
- **Device mode is for the app only.** `POST /api/auth/client-code` and
  `/verify` in device mode answer 403 `reason: "device-only"` when the
  request carries an `Origin` or any `Sec-Fetch-*` header: a page must not
  mint a bearer its script can read (the browser flow's session is an
  httpOnly cookie). A device code is stored under an id derived from the
  app's request id, so a browser code and a device code cannot be crossed.
  The device name is trimmed and cut to 80 characters; it never fails a
  sign-in.
- **Dead token rows are reaped.** The nightly sweep `device-tokens-reap`
  deletes a token row 30 days after it was revoked or expired (see
  [maintenance-runner.md](./maintenance-runner.md)).
- The full phone contract is mobile-companion-backend.md, "Three roles on
  the phone".
- **Asset tokens live 10 minutes.** The `?at=` token `GET /api/shell` gives
  a client lives 10 minutes (a member's lives 2 hours). The client byte
  routes went in W5c (the gate no longer takes a token there), and the
  admin and member byte routes refuse a client's token.

## 5. What a client reads

Removed in W5c: "Shared with you", the client tree and the client byte
routes (each answers 410). The redaction a client read used stays for what
still needs it: `packages/content/src/client-redact.ts` builds the indexed
text of client and public pages ([pages.md](./pages.md) section 3).

## 6. One origin

The client's browser session is a cookie on the brain's origin (only the
phone app holds a bearer). So the client pages must be served on the same origin as
the brain: the same-origin Caddy shape (`MANTLE_CADDY_SHAPE=same-origin`,
the default). On a split-origin box (the owner UI on its own hostname) the
sign-in page says client sign-in is not available, shows no form and posts
nothing.

## 7. Operations

- **Restore.** `scripts/db-restore.sh` revokes every open client sign-in
  link and emailed code the dump brought back, and prints the client
  logins (active or disabled) for review. A dump restores each client's
  sessions as they were when it was taken: for a client whose sessions were
  ended, or who was disabled, after that, End sessions or Disable again
  (Settings > Logins) once the app is up.
- **Caddy.** The access log (`infra/caddy/Caddyfile`) replaces a `code`
  query parameter, and the invite code in the path of the invite lookup,
  with `REDACTED`, and drops the Referer header. The sign-in pages
  (`/client-signin`, `/invite`) are served with
  `Referrer-Policy: no-referrer`. (Admin-issued client sign-in links went
  in W5c; old mails may still carry one, so the redaction stays.)
- **The /api/auth POST guard.** The JSON auth POSTs that set or use the
  session cookie (client-code, client-code/verify, login,
  signup, invite/accept, change-password) refuse a cross-site browser
  request (403 `cross-site`) and a body not declared as JSON (415
  `not-json`); logout checks the origin only. An `Origin` must be the
  brain's own, `MANTLE_CLIENT_ORIGIN`, or a named `MANTLE_API_CORS_ORIGINS`
  entry; without one, `Sec-Fetch-Site: cross-site` is refused. A client
  that sends neither header (the mobile app, curl) passes, and the bearer
  routes are left alone (`server/web/lib/auth/preflight.ts`).
- **Mail sync.** Code mails, and replies or forwards of them, are never
  ingested, and a sign-in link code in ingested mail (old mails) is replaced
  ([security.md](./security.md) section 2).
- **Rollback floor.** Never roll a box below v0.232.318 once a client login
  exists ([update-prod.md](./update-prod.md)).

## 8. Client chat, drafts, requests and apps

All removed in workspaces W5c; their routes answer 410 and nothing runs:

- **Client chat.** `GET`/`POST /api/client/chat`, its unread count and
  read cursor, and the client push routes. The client turn's workflow is a
  no-op under its old name (`clientTurnWorkflow`), so a turn left on a
  box's queue ends cleanly; the `mantle.client` queue is no longer
  registered and `MANTLE_CLIENT_TURN_CONCURRENCY` is gone. The client tools
  (`client_shared_list`, `client_shared_search`, `client_shared_open`,
  `client_request_create`) are no longer registered, and the boot reconcile
  disables their rows and the `client-read` group. A client gets no tool
  over MCP either. Requests clients filed before stay on the Requests list.
- **Client drafts and My requests.** The client's own space, uploads,
  submit and recall, My requests and accepted items. The rows and files
  stay in the database until W6b.
- **Client apps** (C6). The launcher, the frame and its ticket, and the
  db and tool brokers. No app runs at client rules any more; an app's
  Table export keeps retrieval depth when a client wrote its data before.
