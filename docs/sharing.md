# Public sharing: read-only links to any content

> **Status: BUILT.** Read-only public sharing ships for every workspace type
> (page, note, task, event, file, app, **table**, **folder**, drawing,
> Present **canvas**): the `shares`
> table + tokens, the public `/s/[token]` route + scoped asset route, the
> server page renderer, per-type presenters, and the owner `<ShareControl>`
> wired into every detail surface, plus the owner's **Shared links** registry
> (`/team-admin?view=shares`) listing every active link with copy/revoke.
> **Deferred (schema-ready):** per-link expiry UI and per-link indexability
> opt-in (`expires_at` / `settings` columns exist; no UI yet).
>
> **Workspaces (W5b2 on).** A link is not a grant and no level drives it.
> Who reads an item inside the brain is its grants to workspaces
> ([workspaces.md](./workspaces.md)). A public link serves its item and its
> served list (`shares.settings.served`, migration 0262): a picture, file,
> drawing or mention shows on the link only when it is on that list, else it
> is left out or reads "Private item". Anyone who may edit the item opens
> or closes its link (for an app or a Present canvas, a Moderator of its home). An Admin user
> with the users area may also close any link of the brain (closing only
> narrows); opening one still needs the edit right. Where
> the text below says "level", read the served list; client links and
> client items are gone (W8a).
>
> Share any **page, note, task, event, file, app, table, drawing, canvas, or
> folder** with
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

**Shareable** node types: every kind whose registry entry has `publicLink`
(`SHAREABLE_TYPES`, packages/client-types/src/kinds.ts): `page`, `note`,
`task`, `event`, `file`, `app`, `table`, `formula`, `draw`, `present`, and
`branch` (= a **files folder**).
**Never shareable:** `secret`, `email` / `email_thread`, `contact`, `journal`
(sensitive), the share API rejects them.

Two of these carry extra semantics:

- **Table**: the link shows the **published** workbook only, never the owner's
  draft (same rule as page drafts). Rows page in through
  `GET /s/[token]/rows` (offset windows off the published sqlite file, no SQL
  passthrough, no draft switch, no distinct endpoint); legacy JSONB tables ship
  their whole doc in the share view. Formula columns aren't stored per-row, so
  they don't appear on the public surface.
- **Canvas** (`present`): the link runs the canvas LIVE, full screen, always
  the latest save (docs/proposals/canvas-files.md 5.3 and 7.2). The page is
  shell-less (as an app's) with a floating "Shared canvas" pill (Replay, Full
  screen; full screen takes the pill along), and it carries
  `Content-Security-Policy: frame-src <origin>/s/<token>/canvas/frame;
child-src (the same); frame-ancestors 'self'`: a sandboxed frame may always
  navigate itself, and only the host page's `frame-src` stops it reaching
  another URL (Firefox and Safari ignore the iframe's `csp` attribute), so it
  names this link's canvas frame alone, not the whole brain
  (`shareCanvasPageCsp`). The island mints a canvas frame ticket at `POST
/s/[token]/canvas/frame-ticket` (bound to the link and the canvas, no login,
  30 s) and the frame loads `GET /s/[token]/canvas/frame?t=`. That route
  answers only the iframe of the link's own page (Fetch Metadata
  `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: same-origin`, else 403: opened
  as a page of its own, a canvas could navigate the whole window anywhere with
  no pill). It resolves the link again on every load and renders the same
  document, CSP and sandbox as the owner's frame, `private, no-store` (its
  refusals `no-store`): the /api default does not reach /s, and a closed link
  leaves no cached copy. Both routes take a per-address rate limit
  (`shareCanvasFrameTicket`, `shareCanvasFrame`). A visitor can read the canvas's whole document (its source), as for a shared app's bundle; the page itself answers `no-store`. The canvas data store
  (`mantle.data`) is not served: the presenter answers each call itself,
  refused. Its media (`mantle.media`) is: a canvas's files go with it, as a
  page's images do, with no switch. The link serves the list the canvas's
  last save made for it (`meta.linkAssets`): the declared files in the
  canvas's own workspace that the saver may edit (as a page link's served
  list holds only what its opener may edit). The asset route checks each
  fetch again: still on the list, still in the canvas's workspace, an mp3,
  ogg, png, jpeg or webp whose first bytes are that type, at most 10 MB. Never a render on this path; the owner frame refuses a link's
  ticket and this frame refuses a login's. A save is live on the link at once, so `present_update` and
  `present_restore` say so (`open_link`) when the canvas has one. Only a
  Moderator of the canvas's home opens, changes or closes its link, as for an
  app (`publicLink: 'moderator'`, linkNeedsModerator): its link runs its code
  for anyone (owner decision, 2026-11-02).
- **Folder** (`branch`): shares **the files and subfolders under the
  folder that are on the link's served list, evaluated per request**. A
  file added later is neither listed nor served until someone ticks it; a
  subfolder not on the list is hidden with everything under it, and a
  subfolder's file count leaves hidden files out. A file moved out is
  denied on its next fetch. Only folders strictly
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
  file ids referenced in its doc (walk `image`/`fileEmbed` nodeIds) that are
  on the link's served list; for a
  `branch` (folder) share, any file whose ltree path is under the folder
  (`path <@ folder.path`, re-derived per request) that is on the served
  list with no unlisted folder between it and the shared folder (the same
  rule as the listing). The shared item itself is always served: a `file`
  share serves the file. An embed added after the link was made is not
  served until someone ticks it. `GET /s/[token]/draw/[drawId]` (a drawing embedded in a shared
  page) and `GET /s/[token]/draw` (a shared drawing) apply the same rule to
  the drawing and to every image its snapshot places: one image that is not
  on the link's served list keeps the snapshot off the link, as the snapshot
  carries it.
  Streams via
  `readFileById` with content-type + range support (video/audio seeking) +
  cache headers. Anything outside the set → 404.
- `jackdaw/app/s/layout.tsx`, minimal public chrome: clean default theme,
  light/dark via `prefers-color-scheme`, a quiet "Shared via Mantle" footer.

---

## 4. Security

- Public routes **never read an owner caller**: they resolve strictly by an
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
  their own logins and read what their workspaces hold
  ([workspaces.md](./workspaces.md)): migration 0176 revoked
  every team link (no item's level changed), nothing makes one (the share API
  and tools answer `team-links-retired`), and the read path never serves a
  team row. An old team link on `/s/<token>` shows a "Sign in as a member"
  page (410) with a link to `/login`; any other dead token is the uniform 404. An OPEN link needs only the active token: the page, the asset bytes and
  the app brokers (the tool broker refuses every call, the db broker takes
  queries only).

## 4a. Clients: gone, and never a link

Client logins are gone (workspaces W8a, [client-logins.md](./client-logins.md)).
A person outside the team who needs to read an item is a user of a
workspace the item is granted to ([workspaces.md](./workspaces.md)). A
link is only ever public.

- **Old client links stay retired** (client logins C3, migration 0192, and
  0262 for links on items that were at client). `/s/` answers such a token
  with a 410 page that names no item, and Shared links lists the retired
  ones without a token.
- **Talking with outsiders about an item** is not a link. The comment
  threads were removed on 2026-10-09.

---

## 4b. Contact shares: removed (migration 0378)

Contact shares (one item shared with one contact, opened with a personal
code) were removed in migration 0378. It deleted every contact share row
and dropped `contact_share_codes`, `share_access_log`, `shares.contact_id`
and `shares.can_write`. Logins with workspaces and password shares replace
them: an outsider who needs an item is a user of a workspace it is granted
to, or reads it on an open link. The gate is now
`server/web/lib/share-gate.ts` (`openShareLink`): one item, one active
link, read only.

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

Before rendering, an **open link** reads the page through its served list
(`loadShareView`): a mention, a link or a child page card of an item not on
the list says "Private item", and an embed of one is left out, since its
bytes are refused anyway. A shared note's markdown goes through the same
rule. (Access matrix M7: the titles and file names of
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

> **Workspaces (W5b2 on).** The Access control no longer sets a level. It
> opens the item's Grant Access panel (`/api/grants/:nodeId`): the home,
> the workspaces the item is granted to with their Write switches, and the
> open link with its served list ([workspaces.md](./workspaces.md)). The
> share API stays for the agent tools and older clients.

The owner app (jackdaw) shows the **Access** button on every detail screen
(pages, notes, tasks, events, files, apps, tables, folders). Anyone who may
edit the item opens or closes its link (for an app, a Moderator of its
home). An Admin user with the users area may also close any link of the
brain (`DELETE /api/shares/:id`), since closing only narrows; opening one
still needs the edit right. Every link is open (`public` is the only mode); team links are
retired (member logins Phase 6) and client links are retired (client
logins C3, then W8a). The owner's Shared links list
(`/team-admin?view=shares`) shows each live link and marks the retired
ones.

Pages and Draw carry it on their **list preview** as well as in the editor, so
an item can be shared without opening it. The preview's control deliberately
passes no `beforeEnable`: a list screen holds no draft to commit (for Draw it
could not, since committing means capturing the snapshot in the editor), so the
link serves the last **committed** content. That is what `/s` renders in either
case; the "Draft · uncommitted" badge beside the title is what tells the owner
their newer edits aren't in it yet.
API (owner-scoped: the handler reads the owner the gate answered, `ownerCaller()`):

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
pages is shared by granting their **folder** to a workspace in its Grant
Access panel (folder shares by level answer 410 since W5b2); an open link
stays per item. `revokeShareTree` and `applyShareMode` are plain
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
  active link per node) → returns `{ url, token, mode }`; its `serve`
  input sets the served list. `mode` may only be `'public'`: `'team'` is
  refused (`team-links-retired`); `node_share` answers the same. A link is
  no grant: to show a page to users, grant it (or its folder) to their
  workspace. The URL is built with `shareUrlForToken`. (The `children` option
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
