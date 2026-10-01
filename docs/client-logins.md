# Client logins

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
   or the phone app's device token, deny by default, one client company per
   brain.
2. **Team admin > Clients**: acknowledge "What clients see", add a client,
   issue a sign-in link, end sessions, disable, delete.
3. **Email sign-in codes**: the sign-in sender, the email worker, the card,
   how a code works, its caps and upkeep.
4. **Sessions**: 30 days, sign out ends every session, 10-minute asset
   tokens.
5. **What a client reads**: client items only, no staff fields, redacted
   references, bytes at client level.
6. **One origin**: the client pages need the same-origin Caddy shape.
7. **Operations**: restore, Caddy, the auth POST guard, mail sync, the
   rollback floor.
8. **Client chat**: the client-responder, its fixed tools, requests, the
   lowering guard, caps, its queue, pictures in the thread.
9. **Client drafts, requests and comments**: the client's own space, caps,
   what counts toward storage, comment caps, Review and Take over, accepted
   items, comment threads, what an admin sees, when the client total fills.
10. **Client apps** (C6): the apps a client runs and writes.

## 1. What a client login is

- **A person at the brain's one client company.** `auth.users.role` is
  `client` (migration 0187). A brain serves one client company; two
  companies are two brains.
- **No password.** A client login is made with a password hash nobody
  knows, so no password opens it. Password sign-in, the mobile and bearer
  logins, `POST /api/auth/change-password`, a personal assistant and MCP
  consent all refuse a client. An admin password reset on a client answers
  400 `not-a-password-login`. A client signs in with a link an admin issues
  (section 2), or with a code the brain emails (section 3).
- **A browser, or the phone app.** In a browser the session is a cookie on
  the brain's origin (section 6). The phone app holds a device token (a
  bearer): the emailed code in device mode answers one instead of a cookie
  (section 4, and mobile-companion-backend.md "Three roles on the phone").
  Nothing else mints a client bearer: no password sign-in, no web-client
  token login, no QR pairing.
- **Deny by default.** A client reaches only the routes in `CLIENT_ROUTES`
  (`server/web/lib/auth/client-routes.ts`): its shell, "Shared with you"
  (list, item and the item's comment thread), the bytes of client files and
  drawings, its own chat (section 8), its own space, uploads and review
  talk, My requests and its accepted items (section 9), and the client apps
  (section 10). Every admin and member gate refuses it with 403
  `client-login`; `server/web/server/client-sweep.test.ts` drives every
  route of the manifest with a client session to prove it.
- **A client stays a client.** `PATCH /api/users/:id` refuses a role change
  to or from client. To make a client a member, disable the login and
  invite the person as a member.

## 2. Team admin > Clients

1. **Acknowledge "What clients see" first** (Team admin). It lists every
   item at client, its old link, where a page was emailed and the team or
   admin items it names (access-levels.md section 7). Add client and Issue
   sign-in link are refused with 409 `report-not-acknowledged` until an
   admin has acknowledged it, and again once a new item goes to client.
2. **Add client.** Pick a contact, or type an email (and a name if you
   like). `POST /api/team-admin/clients`.
   - With a contact: it must be a contact of this brain with no login. The
     email and the name default to the contact's. A typed email must be one
     of the contact's own addresses, else 400 `email-not-on-contact`: add
     the address to the contact first, or leave the email empty. The mail
     gates know a client by its contact, so a login under another address
     would be a stranger to them.
   - 409 when a login already has the email or the contact.
   - `POST /api/users` never makes a client. Clients are made here only.
3. **Issue sign-in link.** `POST /api/team-admin/clients/:id/signin-link`.
   - The link is shown **once**. Its path is `/client-signin#code=…`; the
     app puts its own origin in front. Copy it and hand it to the client.
   - It lives **72 hours** and works **once**. A new link revokes the
     login's older open ones. **Revoke sign-in link** (`DELETE` on the same
     path) revokes the open one.
   - The code is 16 characters (about 92 bits), stored only as its
     SHA-256.
   - The client opens the link and types their email. The email is a
     check, never a choice: the link signs in only the login it was issued
     for. `POST /api/auth/client-link` `{ code, email }`; every failure
     (unknown, used, revoked or expired code, a wrong email, a disabled
     login) is the same 401.
4. **End sessions** (`PATCH /api/users/:id` `{ "signOut": true }`) and
   **Disable** (`{ "disabled": true }`) end every session the client holds
   and, in the same transaction, revoke its open sign-in links and emailed
   codes. A link issued before a disable does not work after Enable, and
   End sessions leaves no way straight back in. Issue a new link to let the
   client in again.
5. **Delete** (`DELETE /api/users/:id`) removes the login. Its links and
   codes go with it (foreign key cascade), and so does its whole chat
   thread with the client assistant. In the same transaction every comment
   the client wrote is deleted, the client threads and its review talk (as
   `DELETE /api/team-admin/clients/:id/comments` does): a comment whose
   login is gone could no longer be found by that bulk delete. The answer
   says how many went: `{ ok: true, commentsDeleted }`. The app activity
   log names its rows "Removed client". To end a client and keep its chat
   and comments for a dispute or a review, **Disable** it instead.

The list (`GET /api/team-admin/clients`) shows each client's open link
(never its code), its last sign-in and when a link of it was last used. The
routes are admin only and write their own audit rows
(`client.signin_link_issued`, `client.signin_link_revoked`,
`client.signin_sender_set`; the sign-ins write `auth.client_link_signin`,
`auth.client_code_signin` and their `_failed` twins).

## 3. Email sign-in codes

Codes are **off** until an admin picks a sign-in sender. Then a client
without a link types their email on the sign-in page, gets an 8-digit code
by mail, and types it in the same browser.

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
out, so codes are off there whatever the sender, and clients sign in by
link only.

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
and 5 failed verifies per email plus address in 10 minutes; a sign-in link
10 a minute. An address is an IPv4 address, or the /64 of an IPv6 one, so
one IPv6 client cannot rotate through its own block.

There is **no brain-wide failure lockout** on links or codes: a stranger
with many addresses cannot hold every client out. A link code carries about
92 bits, so its cap is a flood guard, not the defence.

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
  working. It does not revoke a sign-in link or an emailed code the client
  has not used yet: End sessions and Disable do (section 2).
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
  reaches only `CLIENT_ROUTES`: `role-sweep.test.ts` drives every manifest
  route with one.
- **90 days from the code, then a new code.** Refresh keeps a client's
  device token alive for at most 90 days from the emailed code that signed
  the phone in (`mobile_tokens.signed_in_at`, copied through every
  rotation). After that, refresh answers 401 with
  `reason: "sign-in-expired"` and the app asks for a new code. A browser
  session has no refresh: it ends after 30 days.
- **Refresh rules (every role).** While more than 23 days remain, refresh
  answers the SAME token and writes nothing. A rotated token presented again
  after a 2-minute grace is a copy in someone else's hands: the brain ends
  every session of the login and writes the audit row `auth.token_reuse`.
  The refresh locks the login row, so it cannot outlive End sessions.
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
- **Asset tokens live 10 minutes.** The `?at=` token a client's image and
  file sources carry lives 10 minutes (a member's lives 2 hours). The client
  byte routes accept it; the admin and member byte routes refuse it.

## 5. What a client reads

- **Client items only.** Every client read runs at the client level
  (`withViewer('client', …)`): client items, never team or public ones. An
  item above that is a plain 404, the same answer as an id that does not
  exist.
- **No staff fields and no summary.** An item comes without its author,
  level or app link. It has no summary: the extractor writes the summary
  from the page's whole text, which may name what the client reads as
  "Private item".
- **A table is its grid.** A client reads a table's committed grid, one tab
  at a time, and nothing else of it.
- **Every reference it cannot read is hidden.** In a page or a note, a
  mention chip or a link to an item the client cannot read keeps its place
  as "Private item" and points nowhere; an embed of such an item (an image,
  a file, a drawing, a child page) is left out. It fails closed: a scheme
  the brain does not know, a `javascript:` link, an **external image** and
  an id that is not an id are hidden too. Plain external links stay.
- **Own-host URLs count as internal.** An absolute URL on the brain's own
  host (`MANTLE_PUBLIC_URL`, `MANTLE_CLIENT_ORIGIN`), or a `/n/<id>`
  permalink on any host, is read as the brain path it stands for, and
  hidden when the client cannot read that item.
- **Bytes.** A drawing is its committed SVG with only its client-level
  images (a team image's frame shows empty). A file streams only when it is
  a client-level file. Both are rate limited per login.

The rules are `packages/content/src/client-shared.ts` and
`packages/content/src/client-redact.ts`. The same filter builds the indexed
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
  ended, or who was disabled, after that, End sessions or Disable again in
  Team admin > Clients once the app is up.
- **Caddy.** The access log (`infra/caddy/Caddyfile`) replaces a `code`
  query parameter, and the invite code in the path of the invite lookup,
  with `REDACTED`, and drops the Referer header. The sign-in pages
  (`/client-signin`, `/invite`) are served with
  `Referrer-Policy: no-referrer`. New links carry the code in the fragment
  (`#code=`), which a browser never sends to a server; links issued before
  carry `?code=` and still work.
- **The /api/auth POST guard.** The JSON auth POSTs that set or use the
  session cookie (client-link, client-code, client-code/verify, login,
  signup, invite/accept, change-password) refuse a cross-site browser
  request (403 `cross-site`) and a body not declared as JSON (415
  `not-json`); logout checks the origin only. An `Origin` must be the
  brain's own, `MANTLE_CLIENT_ORIGIN`, or a named `MANTLE_API_CORS_ORIGINS`
  entry; without one, `Sec-Fetch-Site: cross-site` is refused. A client
  that sends neither header (the mobile app, curl) passes, and the bearer
  routes are left alone (`server/web/lib/auth/preflight.ts`).
- **Mail sync.** Code mails, and replies or forwards of them, are never
  ingested, and a sign-in link code in ingested mail is replaced
  ([security.md](./security.md) section 2).
- **Rollback floor.** Never roll a box below v0.232.318 once a client login
  exists ([update-prod.md](./update-prod.md)).

## 8. Client chat

A client chats with the brain's **client-responder** in the client portal
(`GET/POST /api/client/chat`, the member chat's twin, never shared with it).

- **Every brain has it.** The system manifest ships `client-responder` AT
  CLIENT LEVEL, holding the `client-read` tool group, also at client level.
  A fresh install gets both at onboarding; an existing brain gets both on
  the boot reconcile after its upgrade. Nothing to set up. The reconcile
  converges `client-read` back to client if someone raised it; the agent's
  level is left as an admin sets it. The chat is open only while
  client-responder is enabled and exactly at client level: disable it (or
  raise it) to close the chat (409 `chat-closed`).
- **What it reads is what the portal shows.** Its only tools are
  `client_shared_list`, `client_shared_search`, `client_shared_open` (the
  "Shared with you" items, with every reference to an item the client may
  not read shown as "Private item", section 5), `my_items_list` and
  `my_item_open` (the client's own drafts), and `client_request_create`,
  plus `read_result` for a result too large to send whole. The turn keeps
  only these, whatever the agent's tool groups hold
  (`CLIENT_TURN_TOOL_SLUGS`, `packages/tools/src/client-turn-tools.ts`):
  a group is config, and a brain-wide read tool added to `client-read` would
  still show text the portal never shows. An agent that edits a tool group
  below admin (`tool_group_ensure`) waits in Pending. It
  never holds the brain-wide search and read tools, and its turn loads no
  retrieval context at all (no facts, summaries, passages or graph): those
  were built from page text that can name team and admin items. Search
  matches the words the client sees, not the raw text.
- **Client level, twice.** The agent is at client level, and the whole turn
  also runs inside `withViewer('client')`, so a raised agent still reads at
  client level. A tool group above client that someone grants it is left
  out at run time. A spilled tool result (`read_result`) is readable only by
  the turn that wrote it.
- **Requests.** `client_request_create` files a task in the same Requests
  queue as a member's request, tagged `client-request` and marked "from
  client". It is extract-exempt until an admin acts on it. Caps: 3 per
  message, 10 a day per client login, counted in a ledger
  (`client_request_filings`, 0197), so deleting a request gives nothing
  back. An admin's reply lands in the client's chat thread.
- **Client-written text cannot reach clients through a staff turn.** A staff
  turn that has read client-written text (a client request, a client's chat
  thread, an item a client wrote, or a copy of one) still reads freely, but
  these wait in Pending for the owner:
  - a lowering to client or public: `access_set` to client or public (the
    level is read trimmed and in any case), a share link, `email_page` with
    a link;
  - any write INTO an item already at client or public level: a page,
    note, table, drawing, file, folder, formula or app (its body, blocks,
    rows, draft, commit, title or place), a new page under a client-level
    page, an app whose exported table is at client level, and a tool group
    or agent at client level. A commit takes a page's embeds down only to
    the page's own level, so this also covers every embed a commit would
    lower to client;
  - any call whose target its input does not name by id: a run, a sandbox
    or terminal command, a file overwrite by path, a recipe with a write
    step, an API tool other than a GET, a connector's tool.

  The gate goes by the call's target, not a list of tool names: every
  built-in write tool is classified in
  `packages/tools/src/client-sourced-rules.ts`, a test fails when a new one
  is missing, and an unclassified write waits. An id that names no item of
  the brain waits too. Approving the entry in Pending runs the original
  call.

- **How a turn is marked.** From the ids in every tool call's input and
  output and in its retrieval context, every id checked (no cut-off); a
  delegated child shares the mark. A node the marked turn creates (a note, a
  page split or copied from a request) carries the mark
  (`client_sourced_nodes`, set by the tool loop, never by a tool or the
  model), so a later turn that reads the copy is marked as well.
- **The mark lasts the conversation.** The next turn of the same
  conversation holds the client's text in its history, so it starts marked
  while the last client-sourced read is under 24 hours old
  (`conversation_taints`). The owner's conversation with an agent is one
  across web and Telegram; a member's or client's conversation with an agent
  is its own. SQL only: no trigger, no worker, no model. A heartbeat, a run
  worker and a Studio simulation start unmarked, and a marked turn cannot
  start a run without approval.
- **Client titles stay out of the owner's map.** The corpus map (the recent
  titles every owner prompt carries) leaves out client requests, items a
  client wrote and marked copies. Marking every turn that carries one in its
  map would mark nearly every owner turn and turn Pending into a rubber
  stamp; left out, a client's words reach a staff turn only through a read,
  and every read is scanned.
- **The MCP surface is not gated.** The owner's own MCP clients (Claude
  Desktop, Claude Code) call the brain's tools directly, and the guard lives
  in the brain's tool loop. The brain cannot see what an MCP client's model
  has read: its context lives in the client, and each call arrives on its
  own. A call over MCP is the owner acting by hand, with the MCP client's
  own tool approval as the check: treat a client request read over MCP as
  untrusted text before approving a share or a level change there.
- **Caps.** The member caps, per client login: 6 messages a minute, the
  daily turn cap (`TEAM_CHAT_DAILY_TURNS`) and the daily token budget
  (`MANTLE_MEMBER_DAILY_TOKENS`), taken from the turn ledger when a turn is
  queued. Team admin > Clients shows each client's use today
  (`GET /api/team-admin/clients/usage`).
- **Its own queue.** Client turns run on `mantle.client`, partitioned by
  login with one turn in flight each, `MANTLE_CLIENT_TURN_CONCURRENCY`
  (default 2) across all clients. They never wait behind member or owner
  turns.
- **Sessions end turns.** A queued turn carries the session epoch it was
  sent under. Sign out, End sessions or Disable before it runs, and it
  never runs.
- **Polling.** The portal polls the thread (no live stream).
- **Pictures in the thread** (C6). A reply may place a picture the way the
  owner's assistant does (`![alt](media:<id>)`, or a path to the owner's
  file route). The thread is sent with every markdown image rewritten for
  the client: a file or drawing at client level points at
  `/api/client/files/<id>` or `/api/client/draws/<id>/svg`; any other image
  (an item above client, an id that is no item, an external or `data:`
  image, a form the rewrite does not know) is left out or cannot draw, so a
  client is never pointed at an owner route or made to load a picture from
  another site (`packages/content/src/chat-images.ts`). The member chat
  does the same at team level. The rewritten image is a plain relative
  link, so it loads with the web session cookie only; a surface without
  one (a bearer app) does not show it until the app adds the `?at=`
  asset token.
- **Admins read client chats** in Team admin > Member chats (Clients
  filter), read-only, with the private placeholder rule for replies that
  quoted the client's own drafts.

## 9. Client drafts, requests and comments

A client writes their own pages and notes and uploads files in their own
space (`/api/client/space*`, `/api/client/space-files`), the member space
routes' twins. **My requests** in the portal is one list of them
(`GET /api/client/items`): drafts, submitted, returned, with a reviewer who
took one over, and accepted.

- **Kinds.** Pages, notes and files. No drawings, no tables.
- **Private until submitted.** There is no share route for a client, and the
  database refuses to share a client's item with the team (0189). A client's
  space never shows in Team drafts. Submit sends the saved version to
  Review; Recall takes it back before an admin acts.
- **Caps (lower than a member's).** 20 MB a file, 200 MB a client, 50 MB
  uploaded a day, 500 items, 10 submissions a day (counted in the
  `space_submissions` ledger, so Recall and Submit again still counts) and
  50 waiting for review (an item a reviewer took over counts). All client
  spaces together hold at most 5 GB (`MANTLE_CLIENT_SPACES_TOTAL_BYTES`).
  Over a cap: 409 `quota` with the reason in words (a file over 20 MB:
  413). Two tabs or two clients cannot both take the last place: each cap
  is checked under a lock.
- **What counts toward the 200 MB and the 5 GB.** Files (their size),
  page documents (the saved version, the draft and the plain text) and note
  text, as the database stores them (`pg_column_size`, so compressed text
  counts at its stored size), from one definition
  (`mantle_client_space_usage()`, migration 0195). A text write that makes
  the page or note larger past either limit is refused (409 `quota`); one
  that makes it smaller always passes, so a client over the limit can cut a
  page down. A page document is at most 500 KB serialized and a note at
  most 50,000 characters (400 `too-large`); a member's are 2 MB and
  200,000. A client may make 120 writes a minute (the editor autosaves
  800 ms after a pause), the member count, each at a quarter of a member's
  size. Comments and chat messages do not count toward the 200 MB or the
  5 GB: their day caps bound them (100 comments a day, below, and the
  chat's daily turn cap, section 8).
- **Comment caps.** A client login writes at most 100 comments a day
  across every thread, its review talk and the client threads (429
  `comment-cap`), counted in `client_comment_ledger`: deleting a comment
  does not give the place back. One thread holds at most 1000 comments
  (409 `thread-full`), for members writing there too. Every thread read is
  paged: the newest 100 comments, oldest first, with `hasMore`, and
  `?before=<createdAt of the oldest shown>` for the 100 before them.
- **Request size.** Any JSON body over its route's ceiling is refused with
  413 `body-too-large`: 8 MB by default, 64 KB on the sign-in routes
  (`/api/auth/*`), 128 MB on the owner's document routes; uploads stream
  under their own caps. The gate refuses a declared length before the
  handler runs, and a body without one is cut off while it is read
  (`server/web/lib/body-limit.ts`).
- **Members read client requests** (decision 5 B). A client's SUBMITTED
  item, and what renders inside it, is readable by members as a "Client
  requests" source in their one list (`GET /api/member/client-requests`,
  `/:id`, `/:id/bytes`), read only. A client's draft, returned or accepted
  item is not. Row security holds it: the team role reads a client's item
  only with the human flag on (a member's own request, never an agent) and
  only while it is submitted (migration 0194).
- **Review.** The same queue, with a Client badge. Accept of a client's item
  defaults to level team; client (or public) needs the explicit tick of
  everything that would go down with it. Return with a note shows the note
  to the client as the Returned banner. The badge and the confirmation come
  from the role stamped on the item (`space_items.author_role`), so they
  hold after the client login is deleted.
- **Take over** (member-logins.md section 11). A reviewer may take a
  submitted client item into their own private space to work on it. The
  client's My requests lists it as with a reviewer (its routes answer 409
  `with-admin`, in words that say "a reviewer", never "admin"), under the
  title it had when it was first taken (`space_items.taken_title`), never the
  reviewer's working title; another admin taking it again keeps that first
  title, and Give back or Accept clears it. Give back into the client's
  space is refused while the item names anything the client may not read
  (409 `embed`).
- **Accepted items, as accepted.** `GET /api/client/accepted/:id` serves the
  version accepted (its snapshot), never the brain's current one, and
  without its level. A reviewer who took it over may have named team or
  admin items in it, so a page's doc and a note's text are redacted at the
  client level as "Shared with you" is (section 5): a mention or a link of
  an item the client may not read is "Private item", an embed of it is left
  out. The My requests search matches the accepted title, never a later
  rename. An accepted file's bytes (`/api/client/files/:id`) are served
  under the name and type it was accepted with, and only while the brain
  file still holds the bytes accepted (else `changedByAdmin: true`).
- **Review talk.** On a submitted item the client and the reviewers talk in
  its thread (`/api/client/space/:id/comments`). The client reads only the
  reviewers' comments and their own, never a member's; a reviewer shows as
  the brand name. The database holds this line (0194).
- **Comments on items shared with clients** (decision 8). An item at client
  level carries one thread that the team, admins and every client login
  read and write (`/api/client/shared/:id/comments`,
  `/api/member/library/:id/comments`, the owner's `/api/nodes/:id/comments`;
  `?scope=client` there reads that thread alone, paged the same way, without
  the admins' own talk on the item). Each comment shows its author's
  display name. An admin's comment on an
  item at client level joins that thread; an agent's never does. A thread
  on a team or admin item, a Team drafts item or a public item is never
  shown to a client. Raise the item above client and clients read none of
  it.
- **Client-written text cannot reach clients through a staff turn**
  (section 8): after a staff turn reads a client's item it cannot lower
  anything to client or public, or write into an item clients read,
  without the owner's approval. An item accepted from a client's space
  counts as client-written for good (`space_items.author_role`, kept after
  the login is deleted), and so does a copy a marked turn made of it.
- **Cost.** No client write starts the extractor, a trigger or a worker.
  Accept announces each moved item once, as for a member.
- **What an admin sees.** Team admin > Clients reads
  `GET /api/team-admin/clients/storage`: the total and its use, each client
  space's bytes, uploads today, items and open submissions, and every quota
  refusal of the last 7 days (the reason and the login, nothing of the
  file or text; kept to 7 days and 500 rows). A deleted client's space is
  listed as former and still counts. The 30-day purge removes only its
  private items: what it submitted stays for an admin to accept or discard,
  and counts until one does.
  `GET /api/team-admin/clients/comments?days=7` lists the client-level
  items whose thread had a client's comment lately (the thread itself is
  `/api/nodes/:id/comments`), and
  `DELETE /api/team-admin/clients/:id/comments` removes every comment one
  client wrote, both kinds, in one step (it does not refund their day).
- **When the client total fills.** Every client's uploads and text growth
  are refused with "The storage for client uploads is full" (the refusals
  list says `total`). Read the storage card for who holds what, then any of:
  accept or return the submitted items (accepted items leave the client's
  space and stop counting; a returned one still counts until the client
  deletes it), ask a client to delete drafts they do not need, raise the
  total (set `MANTLE_CLIENT_SPACES_TOTAL_BYTES` in the stack's `.env` and
  restart the web container; no release, but check the disk first:
  `df -h /`), or deal with a client who should no longer have room. Deleting
  or disabling a login frees nothing at once: a deleted client's private
  items count until the purge 30 days later
  (`packages/content/src/member-space-purge.ts`), its submitted items
  count until an admin accepts or discards them (the purge keeps them),
  and a disabled client's space stays as it is. Give back of a taken item into a full
  client space is refused (409 `quota`): accept it or delete it instead.

## 10. Client apps

A client runs the brain's apps at **client level** in the portal
(`/api/client/apps*`, the member app routes' twins, never shared with them).
Only admins create, edit, build, publish, share or delete an app (the app
write tools are `ownerOnly`: refused on a team, client or missing surface).

- **Which apps.** An app at client level with a green published build, and
  nothing else: never a team, admin or public app (a public app is for
  visitors on its link), never a draft. `GET /api/client/apps` lists them by
  title (no level, no author). Any other id, a team app's included, is the
  same plain 404 as an id that does not exist, on every route. It also
  answers `folders`: the admin's Apps folders that lead to one of those
  apps, read only, with no level and no share (docs/folder-tree.md, "Apps
  for members and clients"); a folder with nothing the client may run is
  never named.
- **A shared workspace.** An app at team or client level is a shared
  workspace: everyone who runs it reads AND writes its one database. Members
  write team and client apps; clients write client apps. A public app stays
  read only for members. App data is shared per app, not per person: every
  client login and every member reads what the others wrote.
- **Informational apps.** An admin can mark an app informational
  (`PATCH /api/apps/:id` `{ "dataReadOnly": true }`, admin only; the owner's
  app DTOs carry `dataReadOnly`). Then members and clients only read its
  data: a write answers 403 `{ ok: false, error, reason: 'read-only' }`.
  The member and client app cards carry `dataReadOnly` so the portal can say
  so. Stored as `apps.data_read_only` (migration 0198).
- **Running one.** `POST /api/client/apps/:id/frame-ticket` (30 a minute)
  mints a two-minute ticket that names the client login and its session
  epoch; the sandbox frame (`GET /api/client/apps/:id/frame?t=`) opens only
  with a client ticket, only while the login is an enabled client at that
  epoch: Sign out, End sessions and Disable refuse a ticket minted before
  them, and the brokers below take the session cookie, so a running app's
  next call is refused at once. The owner, member and share frames refuse a
  client's ticket, and the client frame refuses theirs. Published build
  only.
- **Its database.** `POST /api/client/apps/:id/db-broker`
  (`{ op: 'query' | 'exec', sql, params }`, 300 a minute). The level check is
  in the lookup and runs on the client role (row security holds as a second
  lock); the SQLite work runs for the brain. Bounded (client tier audit
  I1): one app's file holds at most 256 MB (`APP_SQL_MAX_DB_MB` in the
  stack's `.env`, web and api; a write past it fails with "database or disk
  is full" and rolls back), a query returns at most 8 MB ("add a LIMIT"),
  and each client login, member login or share link runs one statement at
  a time: its next statement waits its turn (at most 10 s, 16 waiting),
  else 429 `reason: 'busy'`. An error the app's own SQL earned keeps its
  message (400); any other error answers a generic 500, so no server path
  or id reaches a client (L4). The Team admin > Clients storage card
  carries `clientAppDbBytes`: what the databases of client-level apps
  hold (they are not part of the client space limits).
- **Its tools.** `POST /api/client/apps/:id/tool-broker` (`{ slug, input }`,
  60 a minute) calls only a tool the app declares that is one of the client
  tools (`client_shared_list`, `client_shared_search`, `client_shared_open`:
  the "Shared with you" reads, as the portal shows them), a read-only
  built-in with no confirmation, held by an enabled tool group at client
  level (or public). It runs on the client role, on a client surface that
  names the login, as the client chat does. A brain-wide read tool
  (`search_chunks`, `page_get`, `node_read`) is refused even when a
  client-level group holds it: its summaries and chunks are built from text
  above client level. `my_items_list` and `my_item_open` are refused as well:
  they read the client's private drafts, and an app could copy them into its
  shared database (`clientAppToolVerdict`,
  `packages/tools/src/client-app-tools.ts`).
- **The same rules for every runner.** A client-level app's tools run by
  the client rules whoever runs it (`appToolLevel`,
  `packages/tools/src/app-tool-level.ts`, client tier audit L1), in the
  owner, member and client brokers alike. So a member's or an admin's run
  of a client-level app gets the client rules above, on the client role and
  a client surface naming their login: whatever a run reads can be stored
  in the app's database, which every client reads with any SQL, so no run
  reads above client (Jason, 2026-09-30). Team, admin and public apps keep
  the runner's own rules. The author
  warnings on `app_tools_set`, `app_publish` and `access_set` name each
  declared tool the app's level refuses.
- **The access log.** Every ticket, tool call and write, refused calls
  included, lands in the app's access log with the client login
  (`detail.via = 'client'`); a login's reads land at most once per app a
  minute. The `app-access-log-reap` maintenance sweep (nightly, plain SQL)
  deletes rows older than 90 days. The broker calls write no `api.write`
  audit row (the frame ticket and every other client write still do):
  client tier audit I4.
- **Client-written rows reach staff through table exports.** A write
  schedules the app's table-export sync (debounced, hash-gated). An
  exported Table stays admin level, and a Table exported from an app at
  client level counts as client-written for the lowering guard (section
  8): a staff turn that reads it waits in Pending before it lowers
  anything to client or public, or writes into an item clients read. A
  client's first write stamps the app's database
  (`app_databases.client_written_at`, migration 0199), and from then on its
  exports stay client-written even if an admin raises the app above client,
  until the export is removed (the rows clients wrote stay in the app).
- **Cost.** A client app starts no model of its own: no tool it may call
  spends. The export sync commits an exported Table only when its rows
  changed, and an app at client level commits at most once every 10
  minutes (the writes in between join the next sync). The Table of an app
  clients write is indexed at retrieval depth only (`data.brain_depth`
  'retrieval': summary, embedding and chunks, never entities, relations or
  facts), so client text never becomes graph facts (client tier audit
  I2).
