# Client logins

> Client logins, phases C0 to C4 and the C2/C2b audit fixes. The operator's
> guide: what a client login is, how an admin lets a client in, how emailed
> codes work, what a client reads, and the client chat (section 8). What a client may read is decided by
> Postgres row security at the client level
> ([access-levels.md](./access-levels.md)); the role checks every route
> makes are in [member-logins.md](./member-logins.md) section 2.

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
- **Browser only.** A client never holds a bearer. Its session is a cookie
  on the brain's origin (section 6).
- **Deny by default.** A client reaches only the routes in `CLIENT_ROUTES`
  (`server/web/lib/auth/client-routes.ts`): its shell, "Shared with you"
  (list and item), the bytes of client files and drawings, and its own chat
  (section 8). Every admin and member gate refuses it with 403
  `client-login`.
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
   codes go with it (foreign key cascade).

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
  working.
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

The client session is a cookie on the brain's origin, and a client never
holds a bearer. So the client pages must be served on the same origin as
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
  `my_item_open` (the client's own drafts), and `client_request_create`. It
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
  message, 10 a day per client login. An admin's reply lands in the
  client's chat thread.
- **Client-written text cannot lower anything.** A staff turn that has read
  a client request or a client's chat thread cannot lower anything to
  client or public on its own: `access_set` to client or public, a share
  link, or `email_page` with a link waits in Pending for the owner. The turn
  is marked from the ids in every tool call's input and output and in its
  retrieval context; a delegated child shares the mark.
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
  spaces together hold at most 5 GB. Over a cap: 409 `quota` with the
  reason in words (a file over 20 MB: 413).
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
  to the client as the Returned banner.
- **Review talk.** On a submitted item the client and the reviewers talk in
  its thread (`/api/client/space/:id/comments`). The client reads only the
  reviewers' comments and their own, never a member's; a reviewer shows as
  the brand name. The database holds this line (0194).
- **Comments on items shared with clients** (decision 8). An item at client
  level carries one thread that the team, admins and every client login
  read and write (`/api/client/shared/:id/comments`,
  `/api/member/library/:id/comments`, the owner's `/api/nodes/:id/comments`).
  Each comment shows its author's display name. An admin's comment on an
  item at client level joins that thread; an agent's never does. A thread
  on a team or admin item, a Team drafts item or a public item is never
  shown to a client. Raise the item above client and clients read none of
  it.
- **Client-written text cannot lower anything** (section 8), and an item
  accepted from a client's space counts as client-written for good
  (`space_items.author_role`, kept after the login is deleted).
- **Cost.** No client write starts the extractor, a trigger or a worker.
  Accept announces each moved item once, as for a member.
