# Public sharing — read-only links to any content

> **Status: BUILT.** Read-only public sharing ships for all five types
> (page, note, task, event, file): the `shares` table + tokens, the public
> `/s/[token]` route + scoped asset route, the server page renderer, per-type
> presenters, and the owner `<ShareControl>` wired into every detail surface.
> **Deferred (schema-ready):** per-link expiry UI and per-link indexability
> opt-in (`expires_at` / `settings` columns exist; no UI yet).
>
> Share any **page, note, task, event, or file** with anyone who has the URL.
> The link opens a clean, auth-free page tailored to the content — files in a
> proper media viewer, pages in their full formatting — centered and quiet, with
> nothing from the owner's account exposed beyond that one item.
>
> Companion docs: [`pages.md`](./pages.md) (the page schema this renders),
> [`files.md`](./files.md) (the file pipeline assets are served from),
> [`content.md`](./content.md) (note/task/event shapes), [`architecture.md`](./architecture.md)
> (the `nodes` model).

---

## 1. Scope + decisions

**Shareable** node types: `page`, `note`, `task`, `event`, `file`.
**Never shareable:** `secret`, `email` / `email_thread`, `contact` (sensitive) —
the share API rejects them.

Settled design decisions:

| Decision | Choice | Why |
|---|---|---|
| Share model | **Revocable tokens** (a `shares` table) | revoke + expiry + view counts; hides internal node ids |
| Page rendering | **Server static sanitized HTML** | fast, crawlable-by-choice, no client JS for anonymous visitors, safest |
| Indexing | **`noindex` by default** | unlisted — only people with the link; per-link opt-in later |
| Links per item | **One active link per item** | simple mental model (toggle on/off) |

---

## 2. Data model — `shares`

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
revoked row exists); toggling off sets `revoked_at` — the link 404s immediately
because the token is in the URL path (no cache can serve a revoked link).

Helpers (`packages/content/src/shares.ts`, exported from `@mantle/content`):
`createShare`, `revokeShare`, `getActiveShareForNode(ownerId, nodeId)`,
`resolveActiveShareByToken(token)` (active = not revoked, not past `expires_at`).

This **supersedes** the page-only `nodes.data.visibility` flag — a page is
"public" iff it has an active share. The flag can be derived/retired.

---

## 3. Public routes (outside the `(app)` shell)

Live under `apps/web/app/s/…` (not in `(app)`, so they skip the app shell and
get only the root layout). `/s` is added to `PUBLIC_PATHS`
([`lib/auth-constants.ts`](../apps/web/lib/auth-constants.ts)) so middleware lets
them through without a session cookie.

- **`GET /s/[token]`** — server component. `resolveActiveShareByToken` →
  **404** invalid / **410** revoked|expired → load node + sidecar → render the
  type presenter inside the public layout. Best-effort `view_count++`. Emits
  `noindex` (meta + `X-Robots-Tag`) and OG/meta tags (title + summary) for link
  previews.
- **`GET /s/[token]/a/[fileId]`** — public **asset** bytes (P2). The
  security-critical route: serves a file only if `fileId` is in the share's
  **allowed set** — for a `file` share, the file itself; for a `page` share, the
  file ids referenced in its doc (walk `image`/`fileEmbed` nodeIds). Streams via
  `readFileById` with content-type + range support (video/audio seeking) +
  cache headers. Anything outside the set → 404.
- `apps/web/app/s/layout.tsx` — minimal public chrome: clean default theme,
  light/dark via `prefers-color-scheme`, a quiet "Shared via Mantle" footer.

---

## 4. Security

- Public routes **never call `requireOwner`** — they resolve strictly by an
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
  [`lib/rate-limit.ts`](../apps/web/lib/rate-limit.ts)); secrets/emails/contacts
  excluded at the API.
- **Team mode** (`settings.mode = 'team'`, toggle in `<ShareControl teamMode>`):
  the link additionally requires a **live team credential** — the share-scoped
  visitor cookie (minted at the link's own token prompt) or the brain-level
  `/team` hub cookie. Enforced uniformly on the `/s/` surface: the page render,
  the asset-bytes route, and the app brokers all resolve
  `resolveShareVisitor` and re-check membership liveness per request
  (revocation is instant). Team-mode **page** shares double as the `/team`
  hub's briefing sections, and team-mode **app** shares (with a green published
  build) double as the hub's "Team apps" launcher cards — revoking the share,
  or the build going red, delists them (`@mantle/content/team-hub`). The
  designated hub app itself never appears on its own launcher.

---

## 5. Rendering a public page (server static HTML)

`apps/web/lib/render-page-doc.ts` — `renderPageDoc(doc, { assetBase }) → string`
(sanitized HTML). Built on `@tiptap/html`'s `generateHTML(doc, headlessSchema)`
so it **reuses each node's `renderHTML`** (a headless schema with no React
NodeViews), then post-processes:

1. **Math** — replace `[data-type="inline-math"|"block-math"]` with
   `katex.renderToString(latex)` (server-rendered; no client KaTeX).
2. **Code** — `lowlight`-highlight `<pre><code>` into hljs spans (matches the
   existing `.ProseMirror .hljs-*` theme CSS).
3. **Callouts / asides** — `renderHTML` emits `<div data-callout data-variant>`
   and `<div data-aside data-color style="background:…">` (the aside carries its
   themed gradient inline, from the shared `aside-style.ts` helper, so the public
   render matches the in-app NodeView), so ship **public callout/aside CSS** for
   the box geometry (columns, tables, task-lists already have CSS in `globals.css`).
4. **Images** — rewrite `src` → `/s/[token]/a/[fileId]`.
5. **Sanitize** — escape text/attrs; restrict link protocols.

> This is a **third** representation of the page schema (the TipTap editor,
> `markdownToDoc`, and now JSON→HTML). They're kept in sync by the shared schema
> + tests; consolidating is a future cleanup.

---

## 6. Per-type presenters

Clean, centered, media-appropriate (`apps/web/components/share/`):

| Type | Presentation |
|---|---|
| **Page** | `renderPageDoc` HTML; centered reading column (respect `data.width`), title + icon. Full formatting (callouts/columns/tables/code/math/images). |
| **Note** | Markdown via `ReactMarkdown` + `remarkGfm` + `prose`, centered. |
| **File** | Switch on `mimeType`: image (centered, zoom) · pdf (embedded viewer) · video/audio (`<video>`/`<audio controls>`) · text/markdown/code (rendered / lowlight) · else download card (icon, name, size). |
| **Task** | Card: title, status badge, priority, due date, body markdown. |
| **Event** | Card: title, formatted date/time range, location, body, **"Add to calendar" (.ics)**. |

All themed via tokens. *(Note: the in-app file view only handles text today — the
media presenters are net-new here.)*

---

## 7. Owner-side UX

A reusable **`<ShareControl>`** (`components/share/share-control.tsx`) on every
detail screen (pages, notes, tasks, events, files): a *"Anyone with the link can
view"* toggle → mint token → show URL + **Copy** → **Revoke** (and, P4, expiry +
"allow search engines"). API (owner-scoped via `requireOwner`):

- `POST /api/shares` `{ nodeId }` → `{ token, url }`
- `DELETE /api/shares/[id]` → revoke (cascades to the subtree if the share does — §7b)
- `PATCH /api/shares/[id]` `{ mode }` → public/team admission (cascades if the share does)
- `GET /api/shares?nodeId=` → current active link (if any) + `childCount` (descendant pages)
- `POST /api/shares/cascade` `{ nodeId, on }` → turn subtree sharing on/off (§7b)

---

## 7b. Sharing a page's subtree — "Share sub-pages"

A page's Share popover shows a third toggle, **Share sub-pages**, whenever the
page has descendant pages (`teamMode` pages via `<ShareControl allowCascade>`).
Turning it on shares every descendant page; turning it off — or un-sharing the
parent — revokes those child links. Children **mirror the parent's mode**: flip
the parent public↔team and the shared children follow.

- **Intent lives on the parent share:** `settings.cascade = true`
  (`shareCascadeOf`). Children are ordinary shares; the flag is what makes mode
  changes and un-share propagate. No schema change (jsonb `settings`).
- **Snapshot, not live:** toggling on shares the pages that exist at that moment
  (descendants via the `parent_id` recursion, `listPageDescendantIds`). A page
  added later isn't auto-shared — re-toggle to pick it up.
- **Helpers** (`packages/content/src/shares.ts`): `setShareCascade(ownerId,
  parentNodeId, on)`, and the cascade-aware drop-ins `applyShareMode` /
  `revokeShareTree` used by the PATCH / DELETE routes.
- **Hub interaction:** team-mode pages are hub cards, so `listTeamHubSections`
  surfaces only the **top-most** team-shared page of a subtree — a descendant of
  another team-shared page is left off (still openable via its own link, e.g.
  from within the parent). Otherwise cascade-sharing a doc index would turn every
  sub-document into its own card.

---

## 7a. Agent-side UX — Saskia can share pages

The same token CRUD is exposed to the chat agent for **pages** via two tools
([`packages/tools/src/builtins-pages.ts`](../packages/tools/src/builtins-pages.ts)),
so *"share that page and send me the link"* works end to end:

- **`page_share { id }`** → `createShare` (idempotent — one active link per node)
  → returns `{ url, token }`. The URL is built with `shareUrlForToken`.
- **`page_unshare { id }`** → `getActiveShareForNode` → `revokeShare`. No-op if
  unshared.

Both are auto-granted at boot (`CORE_AUTO_GRANT_SLUGS`). Because the agent runs
outside the web request cycle, it can't read an origin from the request — share
URLs come from `publicBaseUrl()` ([`packages/content/src/shares.ts`](../packages/content/src/shares.ts)),
which reads `MANTLE_PUBLIC_URL` ?? `NEXT_PUBLIC_APP_URL` (falls back to
localhost). Set one of those in the agent's environment so links point at the
real host. `email_page`'s `includeLink` option reuses `page_share` to add a
"View online" footer (see [email-send.md](./email-send.md)).

---

## 8. Phasing

1. **Foundation** — `shares` table + token helpers + public route + public
   layout + `renderPageDoc` + **Page & Note** presenters + `<ShareControl>` +
   shares API. Wire the control into page + note detail.
2. **Files** — media presenters + the scoped public **asset route** (the
   meatiest piece). Wire into the files screen.
3. **Tasks & Events** — card presenters + `.ics`. Wire in.
4. **Polish** — revoke/expiry mgmt UI, view counts, OG/social cards, rate
   limiting, per-link indexability opt-in.

---

## 9. Open questions / deferred

- **Range requests on the asset route** — needed for smooth video/audio
  seeking; the existing `?raw=1` route doesn't do ranges, so the public asset
  route adds them.
- **Theme of the public page** — fixed clean default vs. the owner's chosen
  color theme. Defaulting to clean + `prefers-color-scheme`.
- **Federation** — Mantle-to-Mantle sharing over MCP is a separate concern; this
  is human-facing link sharing only.
- **`docToText` already indexes** shared content normally — sharing doesn't
  change ingestion; it's purely an outbound read surface.
