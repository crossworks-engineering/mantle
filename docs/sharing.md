# Public sharing: read-only links to any content

> **Status: BUILT.** Read-only public sharing ships for every workspace type
> (page, note, task, event, file, app, **table**, **folder**): the `shares`
> table + tokens, the public `/s/[token]` route + scoped asset route, the
> server page renderer, per-type presenters, and the owner `<ShareControl>`
> wired into every detail surface, plus the owner's **Shared links** registry
> (`/team-admin?view=shares`) listing every active link with copy/revoke.
> **Deferred (schema-ready):** per-link expiry UI and per-link indexability
> opt-in (`expires_at` / `settings` columns exist; no UI yet).
>
> Share any **page, note, task, event, file, app, table, or folder** with
> anyone who has the URL.
> The link opens a clean, auth-free page tailored to the content, files in a
> proper media viewer, pages in their full formatting, centered and quiet, with
> nothing from the owner's account exposed beyond that one item.
>
> Companion docs: [`pages.md`](./pages.md) (the page schema this renders),
> [`files.md`](./files.md) (the file pipeline assets are served from),
> [`content.md`](./content.md) (note/task/event shapes), [`architecture.md`](./architecture.md)
> (the `nodes` model).

---

## 1. Scope + decisions

**Shareable** node types: `page`, `note`, `task`, `event`, `file`, `app`,
`table`, `branch` (= a **files folder**).
**Never shareable:** `secret`, `email` / `email_thread`, `contact`, `journal`
(sensitive), the share API rejects them.

Two of these carry extra semantics:

- **Table**: the link shows the **published** workbook only, never the owner's
  draft (same rule as page drafts). Rows page in through
  `GET /s/[token]/rows` (offset windows off the published sqlite file, no SQL
  passthrough, no draft switch, no distinct endpoint); legacy JSONB tables ship
  their whole doc in the share view. Formula columns aren't stored per-row, so
  they don't appear on the public surface.
- **Folder** (`branch`): shares **the files under the folder, subfolders
  included, that sit at the link's level, evaluated per request**. The link
  shows public items (`linkLevels`, lib/shares.ts; no client link is made
  since client logins C1, and the old ones retired in C3). A file added
  later lands at admin like every new item (levels are never inherited), so
  it is neither listed nor served until someone lowers it (the Access
  control's "Lower them too" does that for a folder's contents: a folder's
  contents never follow it on their own); a subfolder
  above the level is hidden with everything under it, and a subfolder's file
  count leaves hidden files out. A file moved out is denied on its next
  fetch. Only folders strictly
  under the `files` root qualify (`isShareableFolderPath`); the root itself is
  deliberately not shareable, so "share my entire filesystem" can never be one
  accidental toggle. Visitors get a read-only listing with downloads; subfolder
  navigation stays inside the share (`?p=` is validated as a descendant before
  anything is listed).

Settled design decisions:

| Decision       | Choice                                  | Why                                                                    |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Share model    | **Revocable tokens** (a `shares` table) | revoke + expiry + view counts; hides internal node ids                 |
| Page rendering | **Server static sanitized HTML**        | fast, crawlable-by-choice, no client JS for anonymous visitors, safest |
| Indexing       | **`noindex` by default**                | unlisted, only people with the link; per-link opt-in later             |
| Links per item | **One active link per item**            | simple mental model (toggle on/off)                                    |

---

## 2. Data model: `shares`

A new table (`packages/db/src/schema/shares.ts`, migration `00XX_shares.sql`):

```
shares
  id           uuid pk
  token        text unique         -- 128-bit CSPRNG, base62 (~22 chars), the URL
  owner_id     uuid                 -- scopes mgmt; never exposed publicly
  node_id      uuid                 -- the shared node
  node_type    node_type            -- denormalised for routing/validation
  created_at   timestamptz
  revoked_at   timestamptz null     -- toggle-off / revoke
  expires_at   timestamptz null     -- optional (P4)
  view_count   int default 0
  last_viewed_at timestamptz null
  settings     jsonb                -- { allowIndex?: bool, ... } (P4)
```

**One active link per node** is enforced by a unique partial index:
`UNIQUE (node_id) WHERE revoked_at IS NULL`. Toggling on mints (or re-mints if a
revoked row exists); toggling off sets `revoked_at`, the link 404s immediately
because the token is in the URL path (no cache can serve a revoked link).

Helpers (`packages/content/src/shares.ts`, exported from `@mantle/content`):
`createShare`, `revokeShare`, `getActiveShareForNode(ownerId, nodeId)`,
`resolveActiveShareByToken(token)` (active = not revoked, not past `expires_at`).

This **supersedes** the page-only `nodes.data.visibility` flag; a page is
"public" iff it has an active share. The flag can be derived/retired.

---

## 3. Public routes (outside the `(app)` shell)

Live under `server/web/app/s/…` (not in `(app)`, so they skip the app shell and
get only the root layout). `/s` is added to `PUBLIC_PATHS`
([`lib/auth-constants.ts`](../server/web/lib/auth-constants.ts)) so middleware lets
them through without a session cookie.

- **`GET /s/[token]`**: server component. `resolveActiveShareByToken` →
  **404** invalid / **410** revoked|expired → load node + sidecar → render the
  type presenter inside the public layout. Best-effort `view_count++`. Emits
  `noindex` (meta + `X-Robots-Tag`) and OG/meta tags (title + summary) for link
  previews.
- **`GET /s/[token]/a/[fileId]`**: public **asset** bytes (P2). The
  security-critical route: serves a file only if `fileId` is in the share's
  **allowed set**: for a `file` share, the file itself; for a `page` share, the
  file ids referenced in its doc (walk `image`/`fileEmbed` nodeIds) that sit
  at the link's levels; for a
  `branch` (folder) share, any file whose ltree path is under the folder
  (`path <@ folder.path`, re-derived per request) that sits at the link's
  levels with no folder above those levels between it and the shared folder
  (the same rule as the listing). The shared item itself is not filtered by
  level: a `file` share serves the file. Lowering an item is an admin's
  decision for the item AND what it embeds, so a page's embeds go down with
  the page when an admin lowers it or links it (embedding means sharing,
  access-levels.md section 1), and a page link serves them all in normal use;
  an embed an admin later raises above the page on purpose stops being
  served. `GET /s/[token]/draw/[drawId]` (a drawing embedded in a shared
  page) and `GET /s/[token]/draw` (a shared drawing) apply the same rule to
  the drawing and to every image its snapshot places: one image above the
  link's levels keeps the snapshot off the link, as the snapshot carries it.
  Streams via
  `readFileById` with content-type + range support (video/audio seeking) +
  cache headers. Anything outside the set → 404.
- `jackdaw/app/s/layout.tsx`, minimal public chrome: clean default theme,
  light/dark via `prefers-color-scheme`, a quiet "Shared via Mantle" footer.

---

## 4. Security

- Public routes **never call `requireOwner`**: they resolve strictly by an
  active token and only ever return the **one** shared node + its scoped assets.
  No traversal to siblings, no owner data beyond that item.
- Tokens are CSPRNG (~128-bit), revocable, optionally expiring.
- **Asset scoping** is the crux (the "public-scoping of embedded private assets"
  that [`pages.md` §8](./pages.md) flagged): the asset route validates
  `fileId ∈ allowedSet` derived from the shared node, so a page link can't be
  used to read arbitrary files.
- Page HTML is generated from a **known schema** (not pass-through user HTML);
  text + attributes are escaped, `href` restricted to http/https/mailto
  (optional `sanitize-html` for defense-in-depth).
- `noindex` by default; rate-limit public + asset routes (reuse
  [`lib/rate-limit.ts`](../server/web/lib/rate-limit.ts)); secrets/emails/contacts
  excluded at the API.
- **Team mode is retired** (member logins Phase 6 stage 6). A team link
  (`settings.mode = 'team'`) used to require a team code holder's visitor
  cookie, minted at the link's own token prompt. Members now sign in with
  their own logins and list team-level items in their Library
  ([member-logins.md](./member-logins.md) section 9): migration 0176 revoked
  every team link (no item's level changed), nothing makes one (the share API
  and tools answer `team-links-retired`), and the read path never serves a
  team row. An old team link on `/s/<token>` shows a "Sign in as a member"
  page (410) with a link to `/login`; any other dead token is the uniform 404. An OPEN link needs only the active token: the page, the asset bytes and
  the app brokers (the tool broker refuses every call, the db broker takes
  queries only). A CONTACT share (section 4b) is not open: it needs the
  contact's code as well.

## 4a. Clients: they sign in, never a link

A client of the brain's one client company reads with its own client login
([client-logins.md](./client-logins.md)), never through a link. So a link
is only ever public (the level model: [access-levels.md](./access-levels.md)
section 7):

- **An item at client has no link.** Setting an item to client revokes its
  open link; `createShare` refuses an item at client with
  `client-links-retired`, so `node_share`, `page_share`, `POST /api/shares`
  and the email link all meet it, and `email_page` with a link on a client page is refused
  before anything is sent. The signed-in clients read the item in their
  portal instead, with every reference to an item above client hidden.
- **Old client links are retired** (client logins C3, migration 0192).
  Links made when client meant "anyone with the link" were revoked and
  marked `settings.retired = 'client'`; the item kept its level. `/s/`
  answers such a token, and never serves a link on a client item, with a
  410 "Sign in as a client" page (no item title) pointing at
  `/client-signin`. Shared links lists the retired ones, without a token.
- **Public is not client.** The client role reads client items only, never
  public ones: a public item is reached by its own link, and an item that
  goes public (set by hand, or embedded in something that goes public)
  leaves the client logins' view. The tools say so when it happens
  (`clientLeftWarning`).
- **Before the first client.** An admin acknowledges "What clients see":
  every item at client, its old links, the addresses a page was emailed to,
  the team or admin items it names, and old links above it
  (`GET /api/access/client-report`; access-levels.md section 7).
- **Talking with clients about an item** is not a link. The client thread
  on client-level items was removed on 2026-10-09 with every other comment
  surface; user-to-user talk moves to the forum (dev-brain plan Forum v2).

---

## 4b. Contact shares: one item, one contact (migration 0214)

An admin shares ONE item with ONE outsider without showing it to the team:
a contact share. The item's level never changes, so an admin item stays
admin and no member or client lists it. No login, no role, no email, no
brain tools (only an outside tool with External access, below).

**The contact's code.** On the contact, "Enable sharing" makes an
8-character code from the look-alike-free 54-character alphabet of the
retired team codes (about 46 bits), shown ONCE (docs/contacts.md,
"Sharing"). Only an HMAC-SHA256 of (contact id, code) is stored, keyed from
`MANTLE_MASTER_KEY` (HKDF, fixed label): a database copy alone recovers no
code, and a master key change ends every code (regenerate them).
`contact_share_codes` keeps one row per contact that ever had sharing; its
`code_epoch` only goes up (regenerate, switch off), so a visitor cookie of
an older epoch never matches again. Switch off revokes every live share of
the contact in the same transaction; Enable again gives a new code and no
shares. A share create locks the contact's code row (FOR SHARE) before it
checks that sharing is on, so it cannot slip past a switch off running at
the same time; Enable from off also revokes any live share of the contact
in its own transaction. A double click (two Enables, or two identical
share requests, at once) answers one code (the other `alreadyOn`, 409) and
one share, never a 500. Deleting the contact removes its code row and its
shares; its trail rows stay (below).

**The share.** `shares.contact_id` names the contact; each contact gets its
own row, so its own token and link (`/s/<token>`, 128 bits). One live share
per item and contact (`shares_node_contact_uq`); the one open link per item
is unchanged (`shares_node_open_uq`). A trigger refuses a contact of another
owner, a node that is not a contact, an item that is not a workspace kind,
and a folder (not in v1). `can_write` is allowed only on a contact share of
an app (a CHECK).

**Levels never move.** Every level path reads open links only: a level
change (admin, team, client or public) leaves contact shares alone, and
removing a contact share (`DELETE /api/shares/:id`, the item's share dialog
and the contact's "Shared" tab) is a revoke only. An item at client may
carry contact shares (they are not an open link) and stays at client.
`node_share`, `page_share`, the email link and `POST /api/shares` make and
revoke only the open link.

**The gate** (`server/web/lib/contact-share-gate.ts`). An open link passes
as before. A contact share passes only when the share is live, the contact
has sharing on and is not locked, and a value in the `mantle_contact`
cookie names THIS contact, this brain and the contact's current code epoch.
Otherwise the page is the code prompt (401: no item title, no contact name,
no menu) and every other `/s/<token>` route answers 401. The contact is
always the one the share names, never one from the URL or the body.

- Cookie `mantle_contact` (signed, kind `v`): contact id, owner id, code
  epoch, issued, 30 days. HttpOnly, Secure on https, SameSite=Lax (links
  come from mail or chat), Path `/s/`, so the contact's other links open
  with no prompt. A browser may hold values for several contacts (joined by
  `~`, at most 8); the gate tries each.
- The frame navigation carries no cookie, so a contact share's frame
  ticket names the contact and its code epoch, and the frame route checks
  them again.

**The code prompt**, `POST /s/<token>/code { code }`: trimmed, spaces
dropped, then compared in constant time with the HMAC of the share's
contact. Every failure (a wrong code, sharing off, a lock, a revoked or
missing share, an open link) is the same 401 after the same steps. Limits:
per address (an IPv4 address or an IPv6 /64) 10 a minute and 30 an hour;
per share 10 failures an hour (counted from `share_access_log`); per
contact 30 failures a day, then a 24-hour lock, an audit row
(`contact.sharing_locked`) and a "Needs you" notice
(docs/member-logins.md section 12). A try the per-share limit already
refused is logged on the share (`code_failed`) but not counted on the
contact, after the same work: one holder of one link cannot lock all of
the contact's links. The share and contact counters live in the database,
so a restart or a second web process does not reset them. The per-address
limits live in the web process's memory (`rateLimit`): a restart resets
them, and each web process counts its own. A good code sets the cookie and
writes `auth.contact_code_signin`; a bad one `auth.contact_code_failed`.

**What a contact may do.** Read the item. An app only: write its data when
the share has "Can write" (the db broker's `exec`; the write schedules the
app-table export sync and marks `app_databases.client_written_at`, so an
export of those rows counts as written from outside). On an app an admin
marked Informational every write answers 403 `read-only`, Can write or not,
as for members and clients. Never brain tools.
One kind of tool runs: an outside (MCP or http) tool the app declares that
an admin switched "External access" on for (docs/member-logins.md,
"External access: outside tools in shared apps"). It runs on the public
role and a contact surface; the contact may call it by hand with any
input. Every built-in is refused, and an open link runs no tool at all. Pages, notes, files,
tables and drawings stay read only.

**Embeds.** A contact share lowers nothing, so an admin page's images stay
admin. It serves what the shared item itself embeds (its image and file
embeds, its embedded drawings), whatever their level, read only, only while
the share lives: the same idea as "embeds follow their embedder" for folder
shares (0208), with no column. A file the item does not embed is refused.

**"Shared with you".** On a contact share's view, after the gate passed,
the brain renders a small menu: a thin top strip (the site name, then a
"Shared with you (N)" button) for pages, notes, files, tables and drawings,
or a floating pill for an app. It lists the live shares of the contact the
CURRENT share names (one bounded read, at most 50, newest first): kind
icon, title and a link to that item's own `/s/<token>`. Nothing else. An
open link shows no menu.

**Audit.** `share_access_log` records opens (at most one a minute per
share), assets, database reads (sampled the same way) and writes, failed
codes, and refusals with the share's contact: a read-only `exec`, a refused tool
call, and a gate 401 (an allowed tool call is a `tool` row) (no admitting cookie; sampled like an open, at
most one row per share a minute). Rows are reaped after 90 days by the
`app-access-log-reap` sweep. Deleting a share or its contact sets
`share_id` and `contact_id` NULL (like `app_access_log`): the trail stays.
An app's access log also names the contact (`app_access_log.contact_id`),
so its Activity tab shows who. The admin's actions are in `audit_log`:
`contact.sharing_enabled` / `_regenerated` / `_disabled`,
`contact.shares_revoked_all`, `contact.share_created` (nodeId, contactIds,
canWrite) and `contact.share_can_write` (shareId, contactId, value).
`share_access_log` has no owner UI yet (later).

**The honest limit.** The code proves "holds the code", not "owns the
mailbox". If the link and the code travel in the same message, whoever has
that message gets in. Send them apart. Revoke and regenerate are one click.

**Owner API** (admins only):

| Route                                                             | What                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/contacts/:id/sharing` `{ action }`                     | `enable` / `regenerate` (answer the code once), `disable` (revokes every live share) |
| `GET /api/contacts/:id/shares?cursor=`                            | The contact's "Shared" tab: live shares, newest first, 100 a page                    |
| `DELETE /api/contacts/:id/shares`                                 | Revoke all: no level change, sharing stays on                                        |
| `POST /api/shares/contacts` `{ nodeId, contactIds[], canWrite? }` | One share per contact (idempotent per item and contact)                              |
| `PATCH /api/shares/:id` `{ canWrite }`                            | "Can write" on a contact share of an app                                             |
| `DELETE /api/shares/:id`                                          | Revoke one (no level change for a contact share)                                     |

`GET /api/access/nodes/:id` lists `contactShares`; Shared links
(`/api/shares/all`, `/api/team-admin/shares`) name each share's contact;
`access_get` shows them read only. No agent tool makes a contact share
(v1). The contract types are in `@mantle/client-types`
(`dto/contact-shares.ts`). Not built in v1: folder contact shares, a "send
link by email" button.

**Tests.** `packages/content/src/contact-shares.db.test.ts` (data, levels,
codes, menu and Shared tab rules), `contact-share-codes.test.ts` (one code
check path for every failure, the HMAC key, the alphabet),
`contact-shares.test.ts` (the menu is one query),
`server/web/app/s/contact-share-gate.db.test.ts` (the gate on every /s
route, the code prompt, the brokers, embeds, the menu),
`server/web/app/api/contacts/contact-sharing-routes.db.test.ts` (the owner
API), `server/web/app/s/share-link-brokers.test.ts` and
`server/web/server/auth-sweep.test.ts`.

## 5. Rendering a public page (server static HTML)

`server/web/lib/render-page-doc.ts`, `renderPageDoc(doc, { assetBase }) → string`
(sanitized HTML). Built on `@tiptap/html`'s `generateHTML(doc, headlessSchema)`
so it **reuses each node's `renderHTML`** (a headless schema with no React
NodeViews), then post-processes:

1. **Math**: replace `[data-type="inline-math"|"block-math"]` with
   `katex.renderToString(latex)` (server-rendered; no client KaTeX).
2. **Code**: `lowlight`-highlight `<pre><code>` into hljs spans (matches the
   existing `.ProseMirror .hljs-*` theme CSS).
3. **Callouts / asides**: `renderHTML` emits `<div data-callout data-variant>`
   and `<div data-aside data-color style="background:…">` (the aside carries its
   themed gradient inline, from the shared `aside-style.ts` helper, so the public
   render matches the in-app NodeView), so ship **public callout/aside CSS** for
   the box geometry (columns, tables, task-lists already have CSS in `globals.css`).
4. **Images**: rewrite `src` → `/s/[token]/a/[fileId]`.
5. **Sanitize**: escape text/attrs; restrict link protocols.

Before rendering, an **open link** reads the page as the public does
(`loadShareView` → `levelFilteredDoc(owner, 'public', doc)`, the rule a
client page and the indexed text use): a mention, a link or a child page
card of an item the public may not read says "Private item", and an embed of
one is left out, since its bytes are refused anyway. A shared note's
markdown goes through the same rule (`levelFilteredNote`). A contact share
reads the item as it is. (Access matrix M7: the titles and file names of
hidden items showed on public links.)

> This is a **third** representation of the page schema (the TipTap editor,
> `markdownToDoc`, and now JSON→HTML). They're kept in sync by the shared schema
>
> - tests; consolidating is a future cleanup.

---

## 6. Per-type presenters

Clean, centered, media-appropriate (`server/web/components/share/`):

| Type       | Presentation                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page**   | `renderPageDoc` HTML; centered reading column (respect `data.width`), title + icon. Full formatting (callouts/columns/tables/code/math/images).                                                       |
| **Note**   | Markdown via `ReactMarkdown` + `remarkGfm` + `prose`, centered.                                                                                                                                       |
| **File**   | Switch on `mimeType`: image (centered, zoom) · pdf (embedded viewer) · video/audio (`<video>`/`<audio controls>`) · text/markdown/code (rendered / lowlight) · else download card (icon, name, size). |
| **Task**   | Card: title, status badge, priority, due date, body markdown.                                                                                                                                         |
| **Event**  | Card: title, formatted date/time range, location, body, **"Add to calendar" (.ics)**.                                                                                                                 |
| **Table**  | Read-only grid (client): tab bar for multi-tab workbooks, sticky header, "Load more" offset paging via `GET /s/[token]/rows`; legacy JSONB docs render inline.                                        |
| **Folder** | Read-only listing (server) of the items at the link's level: breadcrumbs scoped to the share, subfolder navigation via `?p=`, per-file **Download** through the scoped asset route.                   |

All themed via tokens. _(Note: the in-app file view only handles text today, the
media presenters are net-new here.)_

---

## 7. Owner-side UX

> **Levels drive links (2026-09-26).** The owner UI no longer sets a link's
> mode directly. The Access control sets the item's **level**
> (`PATCH /api/access/nodes/:id`) and the link follows it: none at admin, at
> team (members list a team item in their Library) and at client (signed-in
> clients, client logins C1: a link on a client item is refused with
> `client-links-retired`), an open link at public. Every share path below
> re-derives the level from the link it leaves (a client item never moves
> because of its own link; a client item embedded in something that goes
> public goes public with it, access-levels.md §7), so they stay in step. See
> [access-levels.md §7](./access-levels.md). The share API stays for the
> agent tools and older clients. The text below describes the share model the
> level now drives.

The owner app (jackdaw) shows the **Access control**
(`components/share/access-control.tsx`, which replaced the old
`<ShareControl>`) on every detail screen (pages, notes, tasks, events,
files, apps, tables, folders): one level, Admin / Team / Client / Public,
applied explicitly. Only at Public does a link show, with **Copy**; taking
the item back above public revokes it. There is no admission toggle any
more: every link is open (`public` is the only mode), team links are
retired (member logins Phase 6) and client items have no link (client
logins C1). The owner's Shared links list (`/team-admin?view=shares`) shows
each live link with its level and marks the old client links.

Pages and Draw carry it on their **list preview** as well as in the editor, so
an item can be shared without opening it. The preview's control deliberately
passes no `beforeEnable`: a list screen holds no draft to commit (for Draw it
could not, since committing means capturing the snapshot in the editor), so the
link serves the last **committed** content. That is what `/s` renders in either
case; the "Draft · uncommitted" badge beside the title is what tells the owner
their newer edits aren't in it yet.
API (owner-scoped via `requireOwner`):

- `POST /api/shares` `{ nodeId }` → `{ token, url }`
- `DELETE /api/shares/[id]` → revoke
- `PATCH /api/shares/[id]` `{ mode }` → `public` only, which confirms the open link;
  `team` is refused with 400 `team-links-retired`, anything else is 400
- `GET /api/shares?nodeId=` → current active link (if any); `childCount` is
  always 0 and a link's `cascade` always false since folder phase 7 (kept on
  the wire for older clients, §7b)

---

## 7b. Sharing a page's subtree: retired (folder phase 7)

A public page's Access control used to show **Include sub-pages** and share
the page's descendant pages with its link (`settings.cascade`,
`setShareCascade`, `POST /api/shares/cascade`, `page_share`'s `children`).
Pages do not nest any more ([folder-tree.md](./folder-tree.md), "Pages"), so
there is no subtree to share: the whole of it went on 2026-09-30. A set of
pages is shared by sharing their **folder** with the team or clients
(`PATCH /api/tree/pages/folders/:id { share }`, `tree_folder_update`); an
open link stays per item. `revokeShareTree` and `applyShareMode` are plain
revoke and mode-set now (the names stay as the drop-ins the unshare paths
call); `AccessNodeView.childCount` (0) and a link's `cascade` (false) stay
on the wire for clients from before the pages tree.

---

## 7a. Agent-side UX: Saskia can share anything shareable

The token CRUD is exposed to the chat agent for **every shareable type** since
v0.145.0: `node_share { id, mode? }` / `node_unshare { id }`
([`packages/tools/src/builtins-share.ts`](../packages/tools/src/builtins-share.ts))
mint/revoke a link for a note, task, event, file, app, table, or folder,
thin, confirm-gated wrappers over the same `createShare` path (its validation
owns the rules). Pages keep their dedicated pair
([`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts)),
so _"share that page and send me the link"_ works end to end:

- **`page_share { id, mode? }`** → `createShare` (idempotent, one
  active link per node) → returns `{ url, token, mode }`, and `alsoLowered`
  when the page's embeds went down with it (a client item among them goes
  to public). `mode` may only be `'public'`: `'team'` is refused
  (`team-links-retired`), and a page at client is refused
  (`client-links-retired`: clients sign in to read it); `node_share` answers
  the same. The URL is built with `shareUrlForToken`. (The `children` option
  went with folder phase 7, §7b: share the folder instead.)
- **`page_unshare { id }`** → `getActiveShareForNode` → `revokeShareTree`.
  No-op if unshared.

Both are auto-granted at boot (`CORE_AUTO_GRANT_SLUGS`). Because the agent runs
outside the web request cycle, it can't read an origin from the request, share
URLs come from `publicBaseUrl()` ([`packages/content/src/shares.ts`](../packages/content/src/shares.ts)),
which reads `MANTLE_PUBLIC_URL` ?? `NEXT_PUBLIC_APP_URL` (falls back to
localhost). Set one of those in the agent's environment so links point at the
real host. `email_page`'s `includeLink` option reuses `page_share` to add a
"View online" footer (see [email-send.md](./email-send.md)).

---

## 8. Phasing

1. **Foundation**: `shares` table + token helpers + public route + public
   layout + `renderPageDoc` + **Page & Note** presenters + `<ShareControl>` +
   shares API. Wire the control into page + note detail.
2. **Files**: media presenters + the scoped public **asset route** (the
   meatiest piece). Wire into the files screen.
3. **Tasks & Events**: card presenters + `.ics`. Wire in.
4. **Polish**: revoke/expiry mgmt UI, view counts, OG/social cards, rate
   limiting, per-link indexability opt-in.

---

## 9. Open questions / deferred

- **Range requests on the asset route**: needed for smooth video/audio
  seeking; the existing `?raw=1` route doesn't do ranges, so the public asset
  route adds them.
- **Theme of the public page**: fixed clean default vs. the owner's chosen
  color theme. Defaulting to clean + `prefers-color-scheme`.
- **Federation**: Mantle-to-Mantle sharing over MCP is a separate concern; this
  is human-facing link sharing only.
- **`docToText` already indexes** shared content normally; sharing doesn't
  change ingestion; it's purely an outbound read surface.
