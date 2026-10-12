# Security & safety nets: an overview

> **Update 2026-10-09:** the brain has no comment threads any more (review
> talk, team talk, client threads and task comments are removed, routes, tools
> and UI); the comment rows and their row security stay in the database,
> unread and unwritten. Lines below that describe comments are history.

> How a Mantle brain protects its data, what each external surface can and
> cannot reach, and the safety nets that keep an install honest over time.
> Written to be readable by a security reviewer during a corporate pilot; each
> section links to the deeper doc. The surfaces team members and outside
> people actually touch (**workspaces and their chats**, **former client
> logins** and **shared Apps**) get their own detailed sections (§5, §5a,
> §6). The access model itself: [workspaces.md](./workspaces.md).

---

## 1. Posture in one page

- **Self-hosted, one owner.** A brain runs on infrastructure you control. Its
  data anchors to one owner; every login acts as itself and reads only
  what its workspaces hold (section 2).
  All state lives under `${MANTLE_DATA_DIR}` on that host (Postgres, the object
  store, files, per-app SQLite, backups). There is no vendor SaaS in the data path
  and no phone-home with content.
- **What leaves the box:** prompts + retrieved context sent to the **model
  providers you configure** (or nothing, with local models), outbound email
  you explicitly send, Telegram messages on a paired
  bot, tool calls to any **MCP connector you explicitly connect**
  (model-authored arguments go to that external server; results come back
  fenced as untrusted; see [`mcp-connectors.md`](./mcp-connectors.md)), HTTP calls of any **OpenAPI
  connector you explicitly connect** (compiled http tools calling the one
  base URL you set; see [`openapi-connectors.md`](./openapi-connectors.md)),
  and update checks (version metadata only). That's the list.
- **Workspaces inside the brain, brains between boundaries.** An item is
  read only through a grant to a workspace, and Postgres row level security
  enforces it: every login, and every workspace assistant, runs on a
  limited database role and reads only what its workspaces hold, whatever
  the code asks for ([workspaces.md](./workspaces.md)). Admin users manage
  the brain but read only what their own workspaces hold, and nobody reads
  another user's private workspace or chats. Groups that must not share
  admins at all still get **separate brains**, one per boundary. Features
  are permissive _within_ a workspace and strict _at_ its edge.
- **Robustness over seamlessness.** Standing engineering rule: gates
  (approvals, allowlists, shown-once tokens) are not eroded for convenience,
  and integrity-adjacent changes get the slow, careful treatment.

## 2. Identity & credentials

| Credential                                            | Who holds it                        | Scope                                                                                                                                       | Revocation                                                                                     |
| ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Login + session cookie                                | you, named admins and invited users | what the login's workspaces hold; the Admin areas only for a user of the Admin workspace                                                   | change password or sign out everywhere (ends every session of the login); disable or delete it |
| **Invite code** (16 chars, SHA-256 at rest, 72 hours) | the person an admin invited         | one redeem: set a password and become that member login                                                                                     | revoke the invite; it expires                                                                  |
| API key (`mtlk_`, hashed at rest)                     | the login that made it              | `/api/v1` and `/api/mcp` only, as its login, narrowed by its access and areas ([api keys](./guide/07-api/08-api-keys.md))                  | revoke it; it expires; a password change or sign out everywhere ends it                        |
| **Setup code** (`MANTLE_SETUP_CODE`, about 99 bits)   | whoever can read the box's `.env`   | one first-run signup, while no account exists                                                                                               | it stops working once the first account exists                                                 |
| Share token (~128-bit CSPRNG in the URL)              | anyone with the link                | exactly one shared item and its served list (or one public app)                                                                             | turn the share off                                                                             |

Client logins, their sign-in links and their emailed codes are gone
(workspaces W8a, [client-logins.md](./client-logins.md)): every client login
was archived, disabled and revoked, and the code routes answer 410.

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
  stateless (one year), so it carries the login's `session_epoch`, signed,
  and every request compares it with the row; so does the `?at=` asset
  token (2 hours for an Admin user; 10 minutes for any other login).
  A password change, an admin password reset, disable (and enable again),
  a role change, and sign out everywhere
  (`POST /api/auth/logout` `{ "everywhere": true }`, or an admin's
  `PATCH /api/users/:id` `{ "signOut": true }`) bump it and revoke the
  login's bearers: every copied cookie and token dies on its next request.
- **A device revoke ends that device, browser tab included.** Revoking one
  device token (Users > Devices) does not bump the epoch, so it ends that
  token and the 7-day cookie a browser tab got from it (`POST
/api/auth/sso` binds the cookie to the device token, claim `dj`). An
  `?at=` asset token minted before the revoke still serves bytes until it
  expires (at most 2 hours), and a render cookie for at most 5 minutes;
  End sessions ends those at once.
  The device that changed its own password stays signed in. Details:
  [member-logins.md](./member-logins.md) section 1.
- **Credential races are single-use by construction.** An OAuth
  authorization code is claimed with one `DELETE ... RETURNING`, and a web
  bearer refresh claims the old row with one conditional `UPDATE`, so two
  requests at once cannot both win. `/api/oauth/authorize` answers a
  non-uuid `client_id` as an unknown client, not a 500.
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
  invite/accept, change-password) refuse a cross-site browser request (403
  `cross-site`) and a body not declared as JSON (415 `not-json`). A
  cross-site HTML form can send neither JSON nor our `Origin`. Logout checks
  the origin only; the bearer routes, which set no cookie, are untouched
  (`server/web/lib/auth/preflight.ts`).
- **Old sign-in codes stay out of the brain.** Mail sync skips an old
  client code mail (a marker in its Message-ID, its `X-Mantle-Client-Code`
  header) and any reply or forward of one (the marker in In-Reply-To or
  References), before anything is stored. A sign-in link code (`/client-signin` or
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

| Surface                                       | Auth                                                                                                                  | Reads                                                                                                                                         | Write path                                                                                                                                                                                 | Audit                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `/s/<token>` shared page/note/task/event/file | link token                                                                                                            | that one item + its own embedded assets only                                                                                                  | none                                                                                                                                                                                       | view count                                                          |
| `/s/<token>` **public app**                   | link token                                                                                                            | the app's own SQLite, read-only                                                                                                               | none (no brain tools, no DB writes)                                                                                                                                                        | app access log                                                      |
| `/s/<token>` **contact share** (0214)         | link token + the contact's code (an HMAC-stored 8-character code; a signed cookie per contact, re-checked every call) | that one item + what it embeds, for the one contact the share names; a "Shared with you" list of that contact's live shares                   | an app with "Can write": the app's own SQLite; nothing else (no brain tools, no other writes)                                                                                              | share access log + app access log by contact + audit rows for codes |
| **A login** (web, phone, `/api/*`)           | any login (cookie or device token)                                                                                    | what its workspaces hold (row security on the workspace role); its own threads with each workspace assistant                                 | what it may edit there: items whose home it moderates or whose grant has Write on, app data on the same rule                                                                               | access log + full per-turn traces                                   |
| **Client routes** (`/api/client/*`)           | none: client logins are gone (W8a)                                                                                    | nothing: every route answers any login 410 code gone                                                                                          | nothing                                                                                                                                                                                    | none                                                                |
| Telegram                                      | the user pairs their own chat with a code, then confirms                                                              | the paired user, in the workspace of the bot's assistant                                                                                      | what that user may change there, through the assistant's tools                                                                                                                             | traces                                                              |
| MCP and `/api/v1` (Claude Desktop, scripts)    | OAuth sign-in, an API key or a peer token, as one login                                                               | what that login's workspaces hold; tools that manage the brain only for an Admin user with the area                                          | what that login may change there, narrowed by the key's or peer's access ([mcp-as-a-login.md](./mcp-as-a-login.md))                                                                       | traces + audit                                                      |
| MCP connectors (outbound)                     | owner connects a server explicitly; key/OAuth creds vault-sealed                                                      | the external server sees only the arguments of calls to ITS tools                                                                             | agents granted the connector's `mcp-*` group call the remote tools; results return fenced as untrusted                                                                                     | traces                                                              |
| OpenAPI connectors (outbound)                 | owner connects a spec explicitly; key stays a vault ref                                                               | the service sees only the arguments of calls compiled from ITS spec, sent to the one owner-set base URL                                       | agents granted the connector's `openapi-*` group call the compiled http tools; results return fenced like every http result                                                                | traces                                                              |

Two structural points:

- **Public means self-contained.** A public link never reaches brain tools,
  there is no "safe slice" of a private brain to expose to anonymous visitors,
  so the answer is none (enforced by a hard server-side gate, not convention).
- **Identified beats anonymous.** Everything with real capability requires a
  login, and every action is logged against that name. (Team-mode
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
  can do is what that surface's write path allows (§5, §6). The write hold
  on text a former client wrote stays for now (`client_sourced_nodes`,
  `packages/tools/src/client-sourced.ts`, §5a).
- **Owner-only tools name their caller.** A tool marked owner-only runs only
  on the owner's own surfaces (the web app, Telegram, and the owner paths
  that say so: MCP, runs, delegated children, approved pending calls). A
  turn of a workspace assistant outside Admin, and a caller with NO surface,
  is refused before the tool runs. Missing is never read as the owner.
- **Everything is traced.** Every turn and every tool call lands in `/traces`
  with steps, cost, and timing, the "show me exactly what happened" view.

## 5. Workspaces and their chats (deep): [`workspaces.md`](./workspaces.md), [`conversation.md`](./conversation.md) section 6d

The design assumption: users are high trust within what is shared with
them. A user reads what their workspaces hold and changes only what they
may edit there; everything they do is attributable.

- **One rule, in the database.** A login, and a workspace's assistant, run
  on a limited Postgres role, and row security decides what they read (the
  item's grants). Every update and delete carries the edit or manage check
  in its statement; a miss is "not found". No per-tool checks to forget.
- **Each user reads only their own chats.** A thread is per assistant and
  login, with row security on the login. No Admin user reads another
  user's chat, the owner included, and no assistant does.
- **An assistant reads only its workspace.** The Team assistant (or any
  other workspace's) reads that workspace's items, whoever asks, and writes
  only for a user who could make the change by hand.
- **Private corpus excluded by default.** The owner's email and journal
  stay out of a non-Admin assistant's reach unless an Admin user switches
  on **Expose email & journal** (`teamPrivateReads`, default **off**),
  enforced at tool resolution and on every read path; secrets, Telegram
  chats, saved places and peers are hidden from such turns always
  ([team-chat.md](./team-chat.md)).
- **No spending on the owner's keys outside Admin.** The tools that spend
  on the owner's provider keys are not listed on a non-Admin login's MCP
  surface ([mcp-as-a-login.md](./mcp-as-a-login.md)).
- **Cost containment.** A user who is not an Admin user is held to a daily
  turn cap (`TEAM_CHAT_DAILY_TURNS`) and token budget
  (`MANTLE_MEMBER_DAILY_TOKENS`), checked when a turn is queued, on a
  queue of their own, so a leaked login is a bounded nuisance, not a wallet
  drain. Writes are rate limited per login.
- **Accepted trade-offs, stated plainly:** (1) a user can surface anything
  their workspaces hold, including via injection in content; that is what
  sharing with a workspace means. (2) Users see the same live status
  narration the owner sees, within their workspaces.

## 5a. Former client logins (deep): [`client-logins.md`](./client-logins.md)

Client logins are gone (workspaces W8a, migration 0272). Every client
login was archived (`archive_client_logins`), disabled, its sessions,
device tokens, API keys and OAuth grants revoked, and its peers unbound.
It signs in by no path, and an admin cannot enable it again. An invite or
a new login on a former client's email is refused. The email-code sign-in
and the client portal routes answer 410.

What stays for now: the write hold on text a former client wrote (a turn
that read it cannot widen access without the owner's approval in Pending),
and the mail sync's skip of old code mails. Clients may come back later as
ordinary workspaces, set up by hand.

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
- **An app reads only what every holder reads.** Everyone who runs an app
  shares its database, so an app held by a workspace other than Admin runs
  the narrower rules for every runner, an Admin user's run included
  (`appToolLevel`, `packages/tools/src/app-tool-level.ts`): what a tool
  returns can land in data every holder reads. An app only Admin holds
  keeps the runner's rules. An app a user outside Admin built runs the
  narrower rules too (the author ceiling).
- **Moderators of the home author apps.** The app write tools run in the
  caller's scope: a Moderator of the app's home builds and edits it, and
  the database's create, move and delete checks hold. A missing surface is
  refused, in dispatch and in each handler.
- **One database per app**, no path input; an app can only ever reach its own
  SQLite. `ATTACH`/`PRAGMA` are blocked. The assistant's cross-app access is
  opened read-only _at the engine level_ (any write throws), so no crafted
  query can mutate app data. Bounded: each statement runs in a child process
  with a 5 s limit, 50,000 rows and 8 MB a reply, a 256 MB file cap
  (`APP_SQL_MAX_DB_MB`) and a WAL cap, and one statement at a time per
  login or share link.
- **A share link bounds external capability** (§3): own data, read-only,
  zero brain tools. Users run apps from their own logins (declared builtin
  tools, and data writes where the app's grant has Write on, everything
  audited to the person on the app's **Activity** tab); a shared app can never hand a visitor server-side
  HTTP or shell execution under the owner's account.
- **Durability is first-class.** App DBs run in WAL mode and are snapshotted
  into the standard backup via `VACUUM INTO` (consistent under load), with
  loud reporting when any DB can't be snapshotted.

## 7. Data protection & durability

- **Backups:** built-in scheduled `pg_dump` with rotation
  ([`backups.md`](./backups.md)), off until the owner turns it on.
  `scripts/db-dump.sh` takes the full four-part set: the Postgres dump, every
  per-app SQLite, the table workbooks and the spaces files (the bytes of
  files folded from the old personal spaces).
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
  (`scripts/db-restore.sh` also recreates the five database roles and puts
  the spaces files back); documented and exercised. `.env` is not in
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
2. People are **named, audited, and instantly revocable**; each reads only
   what is granted to their workspaces and changes only what they may edit
   there. Outsiders without a login reach one item at a time, through a
   link or a contact share.
3. The AI's capability is **declared, drift-tested, and gated**: not
   emergent.
4. The honest limits are the workspace model (§1: a user reads everything
   their workspaces hold) and the residual risks of any LLM system
   (injection can steer _reads_ within a workspace; model providers see
   what's sent to them unless you run local models). Both have a clear
   mitigation: **brain per boundary**, and local models where content must
   not leave the site.
