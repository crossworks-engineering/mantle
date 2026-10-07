# Security & safety nets: an overview

> How a Mantle brain protects its data, what each external surface can and
> cannot reach, and the safety nets that keep an install honest over time.
> Written to be readable by a security reviewer during a corporate pilot; each
> section links to the deeper doc. The surfaces team members and outside
> people actually touch (**member chat**, **client logins** and **shared
> Apps**) get their own detailed sections (§5, §5a, §6).

---

## 1. Posture in one page

- **Self-hosted, one owner.** A brain runs on infrastructure you control. Its
  data anchors to one owner; named admins act as themselves, and invited
  member logins and the client company's logins read below admin (section
  2).
  All state lives under `${MANTLE_DATA_DIR}` on that host (Postgres, the object
  store, files, per-app SQLite, backups). There is no vendor SaaS in the data path
  and no phone-home with content.
- **What leaves the box:** prompts + retrieved context sent to the **model
  providers you configure** (or nothing, with local models), outbound email
  you explicitly send, the one-time sign-in codes the brain mails to client
  logins once an admin picks a sign-in sender
  ([client-logins.md](./client-logins.md)), Telegram messages on a paired
  bot, tool calls to any **MCP connector you explicitly connect**
  (model-authored arguments go to that external server; results come back
  fenced as untrusted; see [`mcp-connectors.md`](./mcp-connectors.md)), HTTP calls of any **OpenAPI
  connector you explicitly connect** (compiled http tools calling the one
  base URL you set; see [`openapi-connectors.md`](./openapi-connectors.md)),
  and update checks (version metadata only). That's the list.
- **Levels inside the brain, brains between boundaries.** Every item, agent
  and tool group carries a level (admin > team > client > public), and
  Postgres row level security enforces it: a member login and a team-level
  agent run on a limited database role and read only team-level items (plus
  the member's own personal space), whatever the code asks for, and a
  client login reads client-level items only
  ([access-levels.md](./access-levels.md)). Admins read everything. So a
  level separates what members may read from what only admins may; groups
  that must not share admins at all still get **separate brains**, one per
  boundary. Features are permissive _within_ a level and strict _at_ it.
- **Robustness over seamlessness.** Standing engineering rule: gates
  (approvals, allowlists, shown-once tokens) are not eroded for convenience,
  and integrity-adjacent changes get the slow, careful treatment.

## 2. Identity & credentials

| Credential                                                    | Who holds it                                         | Scope                                                                                                                                                         | Revocation                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Owner/admin login + session cookie                            | you and named admins                                 | the whole app                                                                                                                                                 | change password or sign out everywhere (ends every session of the login); disable or delete the admin user |
| **Member login** + session cookie                             | a person you invited (role member)                   | the member routes only (`MEMBER_ROUTES`): the Library, their chat with the team agent, their personal space, member apps; read at the team level              | disable, demote or delete the login, instant, mid-session                                                  |
| **Invite code** (16 chars, SHA-256 at rest, 72 hours)         | the person an admin invited                          | one redeem: set a password and become that member login                                                                                                       | revoke the invite; it expires                                                                              |
| **Client login** + session cookie (30 days)                   | a person at the brain's client company (role client) | the client routes only (`CLIENT_ROUTES`): "Shared with you", their own space and requests, comment threads, their chat, client apps; read at the client level | sign out (ends every session of the login), End sessions, disable or delete the login                      |
| **Client sign-in link** (16 chars, SHA-256 at rest, 72 hours) | the client an admin issued it to                     | one sign-in as that client login, with the login's email typed as a check                                                                                     | revoke it, issue a new one, End sessions or disable the login; it expires                                  |
| **Client email code** (8 digits, HMAC at rest, 10 minutes)    | the client who asked, in that browser                | one sign-in as that client login, from the browser that asked; 5 wrong tries                                                                                  | End sessions or disable the login; it expires                                                              |
| **Setup code** (`MANTLE_SETUP_CODE`, about 99 bits)            | whoever can read the box's `.env`                    | one first-run signup, while no account exists                                                                                                                 | it stops working once the first account exists                                                             |
| Share token (~128-bit CSPRNG in the URL)                      | anyone with the link                                 | exactly one shared item (or one public app)                                                                                                                   | turn the share off                                                                                         |

Notes that matter to a reviewer:

- **Multi-admin** uses an actor/anchor split: every admin acts as themselves
  (auditable), the brain's data anchors to one owner. Revoking an admin =
  deleting their user.
- The team-code portal (`/team`, `/hub`, the Team Forum, `/api/team/*`)
  was retired in member logins Phase 6: its pages redirect to `/login`, its
  API is gone, and the brain-level team-chat credential (cookie or bearer)
  opens nothing. Team members sign in with member logins
  ([member-logins.md](./member-logins.md)).
- Team codes, the portal's credential, are gone (migration 0178 dropped
  them; an old code opens and redeems nothing). Invite codes are **hashed
  at rest**; the plaintext is shown once at mint. Code-entry endpoints
  return a **uniform 401** for wrong-vs-unknown codes
  (no oracle) and are **rate-limited** per-IP (hardened client-IP derivation
  honouring `MANTLE_TRUSTED_PROXIES`, so the bucket can't be reset by spoofed
  headers) and per-brain on failed codes only, so a few addresses cannot
  lock real invitees out.
- **Sessions can be ended (migration 0181).** The session cookie is
  stateless (one year; 30 days for a client login), so it carries the
  login's `session_epoch`, signed, and every request compares it with the
  row; so does the `?at=` asset token (2 hours; 10 minutes for a client).
  A password change, an admin password reset, disable (and enable again),
  a role change, and sign out everywhere
  (`POST /api/auth/logout` `{ "everywhere": true }`, or an admin's
  `PATCH /api/users/:id` `{ "signOut": true }`) bump it and revoke the
  login's bearers: every copied cookie and token dies on its next request.
  The device that changed its own password stays signed in. Details:
  [member-logins.md](./member-logins.md) section 1.
- **Credential races are single-use by construction.** An OAuth
  authorization code is claimed with one `DELETE ... RETURNING`, and a web
  bearer refresh claims the old row with one conditional `UPDATE`, so two
  requests at once cannot both win. `/api/oauth/authorize` answers a
  non-uuid `client_id` as an unknown client, not a 500.
- **Client sign-in** ([client-logins.md](./client-logins.md)). A client
  login has no password. A sign-in link's code is stored as its SHA-256,
  shown to the admin once, and works once within 72 hours. An emailed code
  is stored as HMAC-SHA256 of the browser's request id and the code, keyed
  from `SESSION_SECRET`, so a copy of the database alone recovers no code;
  it works once, within 10 minutes, in the browser that asked. Every
  failure is one 401, the code request answers the same for every email,
  and the caps count per address (an IPv6 caller by its /64) with no
  brain-wide failure lockout. A client's plain sign-out ends all its
  sessions. Disabling a client, or ending its sessions, revokes its open
  links and codes in the same transaction.
- **The setup code closes the first-run claim race.** While no account
  exists, signup makes its caller the owner, and a native caller passes the
  CSRF guard below; a fresh box on a public address would belong to whoever
  reached it first. The installer generates `MANTLE_SETUP_CODE` (never
  rotated) and prints it; signup requires it until the first account exists
  (timing-safe compare after the per-address rate limit, 403 `setup-code`,
  audited as `auth.signup_failed`). Only the web container receives it, and
  `/api/auth/bootstrap-state` reveals only whether one is required. The
  terminal wizard (`scripts/onboard.sh`) does not ask for it: shell access to
  the box is the stronger proof. See [onboarding.md](./onboarding.md)
  section 8.
- **Login CSRF guard on the auth POSTs** (client logins audit B15). The
  JSON `/api/auth` POSTs that set or use the session cookie (login, signup,
  invite/accept, change-password, client-link, client-code,
  client-code/verify) refuse a cross-site browser request (403
  `cross-site`) and a body not declared as JSON (415 `not-json`). A
  cross-site HTML form can send neither JSON nor our `Origin`. Logout checks
  the origin only; the bearer routes, which set no cookie, are untouched
  (`server/web/lib/auth/preflight.ts`).
- **Sign-in codes stay out of the brain.** Mail sync skips a client code
  mail (a marker in its Message-ID, its `X-Mantle-Client-Code` header) and
  any reply or forward of one (the marker in In-Reply-To or References),
  before anything is stored; choosing the sign-in sender also leaves its
  Sent folders out of sync. A sign-in link code (`/client-signin` or
  `/invite`, in the query or the fragment) in an ingested mail's subject,
  snippet or body is replaced with `[redacted]`. The Caddy access log
  redacts a `code` query parameter and drops the Referer header.
- **No account oracle on the password login:** an unknown email is checked
  against a dummy bcrypt hash of the same cost, so the answer takes as long
  as a wrong password.
- **Personal item ids stay with their owner:** the audit log keeps
  `/api/admin/space/:id/...` and `/api/member/space/:id/...` paths with the
  id replaced by `:id`, and the `my_items_list` / `my_item_open` tools'
  arguments are redacted in trace inputs (every admin reads both).
- **Embeds read schemes like a browser:** the member embed rule strips
  controls and whitespace before testing a scheme, so `java<TAB>script:`
  is refused like `javascript:` (as are `vbscript:` and non-image `data:`).
- **Liveness on every request:** external surfaces re-check membership per
  request, not per session, revocation takes effect immediately.
- Cookies are signed; `secureCookies(req)` keeps auth working correctly on
  plain-HTTP LAN installs without weakening HTTPS ones.
- **Exports rendered in the browser sidecar** (PDF, the drawing rasters in a
  Word export, draw snapshot fills) carry a **render cookie** (kind `r`,
  `mantle_render`): minted for the ACTING admin and one node, 5 minutes,
  accepted only on the render surfaces (`/print/pages`, `/print/draws`,
  `/render/draws`, for the node it names) and the byte routes they load
  (`/api/files/files/:id`, `/api/draws/:id/svg`), GET only, and never as a
  session; the login is re-read on every request. The sidecar sets it as a
  cookie on the print origin (never as an extra header), aborts every request
  to another origin, and the render surfaces send a CSP that allows only
  their own origin (plus `data:` and `blob:`). Before audit F01 it was a full
  session cookie for the anchor, sent to every host a printed page loaded
  an image from ([`server/web/lib/render-sandbox.ts`](../server/web/lib/render-sandbox.ts)).

## 3. The external surfaces: what each can reach

Everything an outside person can touch, in one table. "Write path" is the
complete list of ways that surface can change the brain.

| Surface                                       | Auth                                                             | Reads                                                                                                                                                                                                                                                                            | Write path                                                                                                                                                                                                                                                                                           | Audit                             |
| --------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `/s/<token>` shared page/note/task/event/file | link token                                                       | that one item + its own embedded assets only                                                                                                                                                                                                                                     | none                                                                                                                                                                                                                                                                                                 | view count                        |
| `/s/<token>` **public app**                   | link token                                                       | the app's own SQLite, read-only                                                                                                                                                                                                                                                  | none (no brain tools, no DB writes)                                                                                                                                                                                                                                                                  | app access log                    |
| `/s/<token>` **contact share** (0214)         | link token + the contact's code (an HMAC-stored 8-character code; a signed cookie per contact, re-checked every call) | that one item + what it embeds, for the one contact the share names; a "Shared with you" list of that contact's live shares | an app with "Can write": the app's own SQLite; nothing else (no brain tools, no other writes) | share access log + app access log by contact + audit rows for codes |
| **Member routes** (`/api/member/*`)           | member login                                                     | team-level items (row security on the team role), their own personal space, member apps; the team agent via their own chat thread                                                                                                                                                | their own personal space (items, files, comments on shared items), submit / recall for review, team-level apps (the app's SQLite + its declared built-in tools), one wrapped tool that files a task for human review                                                                                 | access log + full per-turn traces |
| **Client routes** (`/api/client/*`)           | client login (a link or an emailed code)                         | client-level items only (row security on the client role), with every reference to an item it cannot read hidden; no summary; their own items, and what an admin accepted of them as accepted; the client agent via their own chat thread, reading exactly what the portal shows | their own space (pages, notes, uploads; private until submitted, capped), submit / recall for review, comments (review talk on their submitted items, the thread on client-level items; capped), client apps (§5a), one wrapped tool that files a request for human review (3 per message, 10 a day) | access log + full per-turn traces |
| Telegram                                      | explicit bot pairing                                             | owner-level assistant (this is _your_ channel, not a team one)                                                                                                                                                                                                                   | assistant tools per its grants                                                                                                                                                                                                                                                                       | traces                            |
| MCP (Claude Desktop etc.)                     | SSH/exec into the container, operator-only today                 | owner-level tools                                                                                                                                                                                                                                                                | owner-level tools                                                                                                                                                                                                                                                                                    | traces                            |
| MCP connectors (outbound)                     | owner connects a server explicitly; key/OAuth creds vault-sealed | the external server sees only the arguments of calls to ITS tools                                                                                                                                                                                                                | agents granted the connector's `mcp-*` group call the remote tools; results return fenced as untrusted                                                                                                                                                                                               | traces                            |
| OpenAPI connectors (outbound)                 | owner connects a spec explicitly; key stays a vault ref          | the service sees only the arguments of calls compiled from ITS spec, sent to the one owner-set base URL                                                                                                                                                                          | agents granted the connector's `openapi-*` group call the compiled http tools; results return fenced like every http result                                                                                                                                                                          | traces                            |

Two structural points:

- **Public means self-contained.** A public link never reaches brain tools,
  there is no "safe slice" of a private brain to expose to anonymous visitors,
  so the answer is none (enforced by a hard server-side gate, not convention).
- **Identified beats anonymous.** Everything with real capability requires a
  member login, and every action is logged against that name. (Team-mode
  shares, where a team token named the visitor, are retired: a shared app's
  tool broker refuses every call, and members use an app's tools from their
  own login.) A contact share is the one identified outsider: one item, one
  contact, the contact's code, never tools; only an app with "Can write"
  takes a write, into its own SQLite (docs/sharing.md section 4b). Its
  honest limit: the code proves "holds the code", not "owns the mailbox".
  If the link and the code travel in the same message, whoever has that
  message gets in, so they are sent apart; revoke and regenerate are one
  click.

## 4. The assistant's guard rails

The AI itself is fenced the same way people are:

- **Capability = explicit grants.** An agent can only call tools in its
  granted tool groups; the persona's default grant carries a deny-set
  (no terminal, no page-delete, etc.). The whole agent→skill→tool graph is
  declared in one **system manifest**, drift-tested in CI, and live-checked on
  the box ([`system-integrity.md`](./system-integrity.md)).
- **Human approval gate.** Tools marked _requires confirmation_ don't run,
  they queue under **Pending** until you approve or reject. Runtime-composed
  recipe tools live in a safe envelope with the same build→approve→re-ask
  loop.
- **Secrets are sealed.** The vault splits metadata (searchable, so the
  assistant can _find_ a credential) from AES-256-GCM-encrypted values the
  agent never reads ([`secrets.md`](./secrets.md)).
- **Prompt-injection stance:** retrieved content is framed as data, not
  instructions (grounding skills), and (more importantly) the _blast radius_
  is bounded structurally: on external surfaces the worst an injected prompt
  can do is what that surface's write path allows (§5, §5a, §6). Text a
  CLIENT wrote (a client request, a client's chat thread, an item a client
  wrote, a copy of one) cannot move content out: in a turn that read it, a
  lowering to client or public and any write into an item clients already
  read wait for the owner in Pending (client-logins.md §8, §5a below).
- **Owner-only tools name their caller.** A tool marked owner-only runs only
  on the owner's own surfaces (the web app, Telegram, and the owner paths
  that say so: MCP, runs, delegated children, approved pending calls). A
  team or client turn, and a caller with NO surface, is refused before the
  tool runs. Missing is never read as the owner.
- **Everything is traced.** Every turn and every tool call lands in `/traces`
  with steps, cost, and timing, the "show me exactly what happened" view.

## 5. Member chat security (deep): [`member-logins.md`](./member-logins.md), [`team-chat.md`](./team-chat.md) (history)

The design assumption: a team member is _trusted to read the brain's
team-level knowledge_ and to work in their own space, but _never trusted to
write the brain_ without an admin's review, and everything they do must be
attributable.

- **Read-only by construction.** The team responder's tool group is read-only
  brain-wide, with `export_node`, `replay_window`, and all delegation excluded
  , locked by a manifest drift-guard test, so a future manifest edit can't
  silently widen it.
- **Private corpus excluded by default.** Email and journal reads require an
  explicit owner opt-in (`teamPrivateReads`, default **off**), enforced at
  tool resolution independently of the group grant, behind a confirmation
  dialog that spells out the exposure. The same switch filters every read
  path (search, passages, node reads, entity facts, turn retrieval) by node
  type, and secrets, Telegram chats, saved places and peers are hidden from
  team surfaces always (team-chat.md §6).
- **One level system, enforced by the database.** Items, agents and tool
  groups carry a level (admin > team > client > public). A below-admin agent
  runs its whole turn on a limited Postgres login role, and row level
  security decides what it reads: no per-tool checks to forget. See
  [access-levels.md](./access-levels.md).
- **The brain is written only through review.** A member writes their own
  personal space (a separate owner in the same database: never indexed,
  never read by the extractor, invisible to other members unless shared with
  the team) and the databases of team-level apps. Nothing of theirs becomes
  brain content until an admin accepts it (member-logins.md section 6). The
  team agent's one write tool files a review-queue task whose provenance
  (who, from which message, which attachments) is stamped **by the server,
  never from model arguments**: so the worst-case prompt-injection outcome is
  a _clearly team-labelled task in a human-reviewed queue_. Team requests
  never touch the agent tool-execution gate directly.
- **Member isolation.** A member's turn id is minted server-side as
  `member-<loginId>.<nonce>`; a client can never address another member's
  turn, and each login has its own thread. Context assembly injects no owner
  persona notes, digests, or other members' threads. The engine refuses an
  admin-level agent for a member login, and a turn with no login.
- **No memory contamination.** Team conversations are not semantically indexed
  into the brain's memory corpus; the owner reads them via dedicated tools.
  Items a member submits reach the brain only when an admin accepts them
  (member-logins.md section 6).
- **Cost containment.** Per-login rate limit (6 a minute) +
  `TEAM_CHAT_DAILY_TURNS` daily turn cap + `MANTLE_MEMBER_DAILY_TOKENS` daily
  token budget, both checked when a turn is queued (turn ledger, migration
  0182; denials logged), on a queue of their own, so a leaked login is a
  bounded nuisance, not a wallet drain. Change requests a member files are
  capped (3 a message, 20 a day) and reach no model until an admin acts on
  them. A member app never calls a built-in flagged `spends`. Member writes
  are rate limited too (120 a minute per login).
- **Accepted trade-offs, stated plainly:** (1) a member can surface anything
  the team agent can read (every team-level item), including via injection
  in content; that is what setting an item to team means. (2) Members see
  the same live status narration the owner sees, chosen transparency,
  documented, within their level.

## 5a. Client logins security (deep): [`client-logins.md`](./client-logins.md)

The design assumption: a client is a person at the brain's ONE client
company (two companies are two brains), _trusted to read what the team
set to client_ and to write their own requests, but _never trusted with
anything above client_, and with no way to move content between levels.

- **Who.** Role `client`, made only in Team admin > Clients. No password
  opens it: a client signs in with a one-use link an admin issues (72
  hours, about 92 bits, SHA-256 at rest) or an 8-digit code the brain
  emails (10 minutes, 5 tries, HMAC at rest, bound to the browser that
  asked). Browser only, never a bearer; sessions last 30 days, sign out
  ends every session, asset tokens live 10 minutes (client-logins.md
  sections 2 to 4). The client pages need the same-origin Caddy shape.
- **Deny by default.** A client reaches only the routes in `CLIENT_ROUTES`;
  every admin and member gate answers 403 `client-login`, and a sweep test
  drives every route of the manifest with a client session.
- **Reads, by the database.** Every client read runs on the client role:
  client items only, never team, admin or public ones (client and public
  are siblings), agents and tool groups at client level only
  ([access-levels.md](./access-levels.md) sections 1 and 8). What leaves
  the brain is shaped for a client: no author, level, summary or app link;
  a table is its grid; every mention, link or embed of an item the client
  may not read is "Private item" or left out, failing closed on anything
  unknown; bytes, drawing images and SVG links at client level only.
- **Levels drive what they read, not links.** An item at client has no
  open link: clients sign in to read it. Old client links are retired (410
  "Sign in as a client"). Before the first client login an admin
  acknowledges a report of every client item and the team or admin items
  it names ([sharing.md](./sharing.md) section 4a).
- **Writes are their own, and reviewed.** A client writes only its own
  space (pages, notes, uploads; never a drawing or a table; private until
  submitted, never shared with the team), its comments (the review talk on
  its submitted items; the one thread on a client-level item, which the
  team and admins share), its chat, and client apps (client-logins.md
  section 10). Nothing becomes brain content until an admin accepts it,
  at team by default; client or public needs the admin's explicit
  confirmation. Members read a client's item only while it is submitted,
  with the human flag (never an agent).
- **What an admin changes stays the admin's.** An item a reviewer took
  over is given back only if it names nothing above client, and the
  client reads an accepted item as accepted, redacted at client level,
  under the title and file name it had (member-logins.md section 11).
- **The client agent is fenced twice.** `client-responder` runs at client
  level inside a client scope, with no retrieval context and only the
  client tools plus `read_result`, fixed in code whatever its tool groups
  hold (an agent editing a group below admin waits in Pending). Pictures in
  a client's chat point only at client-level items, through the client's
  own routes.
- **The lowering guard.** Text a client wrote is untrusted in every staff
  turn. After a staff turn reads it (by id, anywhere in its tool inputs,
  outputs or retrieval context, for the rest of the conversation for 24
  hours, and through any copy the turn makes), a lowering to client or
  public, and any write into an item already at client or public, wait in
  Pending for the owner; the gate goes by the call's target, and an
  unclassified write waits. Client-written titles stay out of the owner's
  corpus map. The owner's MCP surface is not gated: a call there is the
  owner acting by hand (client-logins.md section 8).
- **Bounded cost and size.** The chat: 6 messages a minute, the daily turn
  cap and token budget, one turn in flight per login on its own queue, and
  a queued turn dies with the session. The space: 20 MB a file, 200 MB a
  client (files and text alike), 50 MB uploaded a day, 500 items, 10
  submissions a day and 50 open, 5 GB for all clients together; 100
  comments a day per client, 1000 per thread, every thread read paged;
  requests 3 a message and 10 a day; every JSON body under a size ceiling.
  Each daily cap counts in a ledger that deleting does not refund. No
  space, comment or request write of a client starts the extractor or any
  other LLM work (client-logins.md sections 8 and 9).
- **Client apps run at client level, for everyone.** A client-level
  app's tools run by the client rules whoever runs it (`appToolLevel`,
  `packages/tools/src/app-tool-level.ts`), so a member's or an admin's run
  (the client tools only, on the client role) cannot copy team or admin
  data into a database every client reads with any SQL. Other apps keep
  the runner's rules. The app database is bounded: 256 MB a file
  (`APP_SQL_MAX_DB_MB`), 8 MB a reply, one statement at a time per login
  or link; a server error's text never reaches the app. A Table exported
  from an app clients write is indexed at retrieval depth only (no facts or
  entities), commits at most every 10 minutes while the app is at client
  level, and stays client-sourced for the lowering guard once a client
  wrote the app, whatever its level later (client-logins.md section 10).
- **Operations.** A restore revokes every open sign-in link and code the
  dump brought back; the access log redacts codes; code mails never enter
  the corpus; Team admin > Clients shows each client's chat use, storage
  and quota refusals (client-logins.md sections 7 and 9).
- **Accepted trade-offs, stated plainly:** (1) whatever the team sets to
  client every client login reads, and an item embedded in a client item
  goes down with it (embedding means sharing). (2) An admin's comment on a
  client-level item is read by every client login. (3) The owner's MCP
  clients are outside the lowering guard.

## 6. Apps security (deep): [`app-authoring-guide.md`](./app-authoring-guide.md)

Mini-apps are user-authored code, so they're treated as untrusted by the host
even when _you_ wrote them:

- **Sealed sandbox.** Apps run in an opaque-origin iframe: no credentials, no
  same-origin access, no direct network. The only window to the host is a
  brokered postMessage bridge; all real work executes server-side.
- **Build-time allowlist.** The bundler rejects any import outside a short
  allowlist (React, the UI kit, icons, the host bridge), no arbitrary npm, no
  supply-chain surface inside an app.
- **Capability is declared per app.** An app may call only the tool slugs
  explicitly set on it; the host refuses anything else at runtime. Secrets and
  API keys resolve server-side, the iframe never sees a key.
- **A client app's tools never read above client.** A client-level app
  runs the client rules for every runner, the owner's included
  (`appToolLevel`), because what a tool returns can land in the app's shared
  database and every client reads it. Other apps keep the runner's rules:
  the owner's run any declared tool, a member's run the member rules
  (read-only built-ins from team-level groups).
- **Only the owner authors apps.** The app write tools (`app_create`,
  `app_file_write`, `app_source_set`, `app_build`, `app_tools_set`,
  `app_db_schema_set`, `app_db_seed`, `app_publish`, `app_delete`, the
  export tools) are `ownerOnly`: refused on a team, client or missing
  surface, in dispatch and in each handler.
- **One database per app**, no path input; an app can only ever reach its own
  SQLite. `ATTACH`/`PRAGMA` are blocked. The assistant's cross-app access is
  opened read-only _at the engine level_ (any write throws), so no crafted
  query can mutate app data. Bounded: each statement runs in a child process
  with a 5 s limit, 50,000 rows and 8 MB a reply, a 256 MB file cap
  (`APP_SQL_MAX_DB_MB`) and a WAL cap, and one statement at a time per
  member login, client login or share link.
- **A share link bounds external capability** (§3): own data, read-only,
  zero brain tools. Members run apps from their own logins (declared builtin
  tools + writes on team-level apps, everything audited to the person on the
  app's **Activity** tab); a shared app can never hand a visitor server-side
  HTTP or shell execution under the owner's account.
- **Durability is first-class.** App DBs run in WAL mode and are snapshotted
  into the standard backup via `VACUUM INTO` (consistent under load), with
  loud reporting when any DB can't be snapshotted.

## 7. Data protection & durability

- **Backups:** built-in scheduled `pg_dump` with rotation
  ([`backups.md`](./backups.md)), off until the owner turns it on.
  `scripts/db-dump.sh` takes the full four-part set: the Postgres dump, every
  per-app SQLite, the table workbooks and the members' personal-space files.
  Getting the folder offsite is deliberately the operator's job.
- **A backup before every roll, enforced.** Migrations are forward-only (some
  drop tables), and any admin can start a roll from Settings > Updates. So
  the updater runs `db-dump.sh` in strict mode (all four parts, or it
  fails) into `backups/pre-roll/` before it changes anything, keeps the
  newest three sets, and **refuses the roll**, nothing changed and the
  reason on the Updates page, when the backup fails or the disk cannot hold
  it ([update-prod.md](./update-prod.md)). The operator can switch it off in
  `.env` (`MANTLE_PRE_ROLL_BACKUP=0`); a request from the app cannot.
- **Encryption:** secrets are AES-256-GCM at rest; invite codes, pairing
  codes and OAuth tokens are stored hashed; disk/transport encryption is the
  host's TLS + volume story (Caddy auto-TLS on the standard deploy).
- **Restore reality:** disaster recovery = restore the dump + the data dir
  (`scripts/db-restore.sh` also recreates the four database roles and puts
  the personal-space files back); documented and exercised. `.env` is not in
  the backup: keep a copy of it, above all `MANTLE_MASTER_KEY`, which the
  sealed secrets need, off the box.

## 8. Operational safety nets

The nets that catch drift and breakage before they become incidents:

- **System integrity checker**: the manifest-driven config graph is verified
  in CI (a dangling tool/skill fails the build) _and_ live on the box
  (`/debug` → Integrity), so silent capability drift is surfaced, not
  accumulated.
- **Sanity check**: a read-only `/debug` tab that inspects
  provisioning-hidden breakage (missing buckets, workers, seeds) on any box.
- **Deploy discipline**: releases are pinned image tags pulled from the
  registry; preflight includes typecheck, the full test suite, and a
  production `next build`; every server roll takes the four-part backup
  first (section 7), and after an OK roll the updater removes this product's
  old server and client images (keeping the rollback pair), so the disk does
  not fill one release at a time.
- **Access logs + traces everywhere** external capability exists (app
  activity, team access log, per-turn traces with cost).
- **Rate limiting** on every anonymous/token entry point.
- **Update visibility**: the in-app updater surfaces new versions and the
  full per-release changelog (`/changelog`), so operators know exactly what a
  roll contains.

## 9. What a pilot reviewer should take away

1. External exposure is **opt-in, enumerable, and small** (§3's table is the
   complete list), with anonymous surfaces structurally incapable of reaching
   brain data.
2. External _people_ are **named, tokenized, audited, and instantly
   revocable**; they write only their own space and team-level apps, and
   reach the brain only through a human-reviewed queue.
3. The AI's capability is **declared, drift-tested, and gated**: not
   emergent.
4. The honest limits are the level model (§1: admins read everything, and
   a member reads everything at team level) and the residual risks of any
   LLM system (injection can steer _reads_ within a level; model providers
   see what's sent to them unless you run local models). Both have a clear
   mitigation: **brain per boundary**, and local models where content must
   not leave the site.
