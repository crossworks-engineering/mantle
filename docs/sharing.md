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
  page (410) with a link to `/login`; any other dead token is the uniform 404. Every link is open now: the page, the asset bytes and the app brokers
  need only the active token (the tool broker refuses every call, the db
  broker takes queries only).

## 4a. Clients: they sign in, never a link

A client of the brain's one client company reads with its own client login
([client-logins.md](./client-logins.md)), never through a link. So a link
is only ever public (the level model: [access-levels.md](./access-levels.md)
section 7):

- **An item at client has no link.** Setting an item to client revokes its
  open link; `createShare` refuses an item at client (and a sub-page asked
  to follow a client parent) with `client-links-retired`, so `node_share`,
  `page_share`, `POST /api/shares`, the email link and "Share sub-pages"
  all meet it, and `email_page` with a link on a client page is refused
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
- **Talking with clients about an item** is the comment thread on a
  client-level item, which the team, the admins and every client login
  read and write (client-logins.md section 9), not a link.

---

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
- `DELETE /api/shares/[id]` → revoke (cascades to the subtree if the share does, §7b)
- `PATCH /api/shares/[id]` `{ mode }` → `public` only, which confirms the open link (cascades if
  the share does); `team` is refused with 400 `team-links-retired`, anything else is 400
- `GET /api/shares?nodeId=` → current active link (if any) + `childCount` (descendant pages)
- `POST /api/shares/cascade` `{ nodeId, on }` → turn subtree sharing on/off (§7b); `skipped`
  lists the client sub-pages that kept client and got no link

---

## 7b. Sharing a page's subtree: "Share sub-pages"

A public page's Access control shows **Include sub-pages** whenever the page
has descendant pages (the switch rides the link, so only at Public).
Turning it on shares every descendant page; turning it off, or un-sharing the
parent, revokes those child links. Children take the parent's level. An old
client link cannot be extended to sub-pages (`client-links-retired`).
Turning it on skips client sub-pages: each keeps client and gets no link
(clients sign in to read it; an old link of its own stays untouched). The
route answers their ids in `skipped`, and `page_share` in `keptAtClient`.
The flag and every sub-page link change in ONE transaction: a failure part
way leaves nothing half done.

- **Intent lives on the parent share:** `settings.cascade = true`
  (`shareCascadeOf`). Children are ordinary shares; the flag is what makes mode
  changes and un-share propagate. No schema change (jsonb `settings`).
- **Snapshot, not live:** toggling on shares the pages that exist at that moment
  (descendants via the `parent_id` recursion, `listPageDescendantIds`). A page
  added later isn't auto-shared, re-toggle to pick it up.
- **Helpers** (`packages/content/src/shares.ts`): `setShareCascade(ownerId,
parentNodeId, on)`, and the cascade-aware drop-ins `applyShareMode` /
  `revokeShareTree` used by the PATCH / DELETE routes.
- **Hub interaction:** retired with team links (member logins Phase 6). The
  members' home app reads the newest team pages by level
  (`GET /api/member/home`), not by share.

---

## 7a. Agent-side UX: Saskia can share anything shareable

The token CRUD is exposed to the chat agent for **every shareable type** since
v0.145.0: `node_share { id, mode? }` / `node_unshare { id }`
([`packages/tools/src/builtins-share.ts`](../packages/tools/src/builtins-share.ts))
mint/revoke a link for a note, task, event, file, app, table, or folder,
thin, confirm-gated wrappers over the same `createShare` path (its validation
owns the rules). Pages keep their dedicated pair, which adds the sub-page
cascade
([`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts)),
so _"share that page and send me the link"_ works end to end:

- **`page_share { id, mode?, children? }`** → `createShare` (idempotent, one
  active link per node) → returns `{ url, token, mode }`, and `alsoLowered`
  when the page's embeds went down with it (a client item among them goes
  to public). `mode` may only be `'public'`: `'team'` is refused
  (`team-links-retired`), and a page at client is refused
  (`client-links-retired`: clients sign in to read it); `node_share` answers
  the same. `children: true|false` shares/unshares the subtree via `setShareCascade`
  (§7b) and reports `subpagesShared` / `subpagesRevoked`, plus `keptAtClient`
  (the client sub-pages that kept client, with no link). The URL is built with
  `shareUrlForToken`.
- **`page_unshare { id }`** → `getActiveShareForNode` → `revokeShareTree`
  (subtree-aware, un-shares cascaded sub-pages too). No-op if unshared.

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
