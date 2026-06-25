# Item permalinks — deep links to any node

A single, type-agnostic URL that opens any item — note, page, todo, table,
app, event, file, contact, life-log entry — straight at its surface. Companion
to [`content.md`](./content.md) (the node model), [`sharing.md`](./sharing.md)
(public `/s/[token]` links), and [`conversation.md`](./conversation.md) (how
responder replies render).

Status: **live (v0.56).** Every node is linkable by id; responders embed these
links in replies and the user clicks straight through.

## Why

Items used to live on master-detail surfaces whose selection was pure client
state — the URL never changed, so nothing could link to a specific item. The
motivating need: let responders (Saskia & co.) reference a document in a reply
as a clickable link the user taps to land on it.

## The permalink — `/n/<id>`

`apps/web/app/(app)/n/[id]/page.tsx` is the one canonical deep link. It loads
the node **owner-scoped**, reads its `type`, and redirects to whichever surface
edits or displays it:

| node type | redirects to |
| --- | --- |
| `note` | `/notes?selected=<id>` |
| `page` | `/pages/<id>` |
| `task` | `/todos?selected=<id>` |
| `table` | `/tables?selected=<id>` |
| `app` | `/apps/<id>` |
| `event` | `/events/<id>` |
| `file` | `/files?file=<id>` |
| `contact` | `/contacts?id=<id>` |
| `lifelog` | `/lifelog?selected=<id>` |
| anything else | `/nodes/<id>/history` (universal node biography) |

Keeping the type→surface map in this one route means **callers never need to
know the type** — they hold only an id — and links survive a surface changing
its URL shape. Surfaces that already deep-linked by id (`/notes/[id]`,
`/tables/[id]` redirects; `/pages/[id]`, `/apps/[id]`, `/events/[id]` pages) are
reused as-is; types without a dedicated editor fall back to the generic
`/nodes/<id>/history` biography, which renders for every node kind.

Security: the loader is owner-scoped, so a leaked id for another owner gets a
**404, not a permission error** (less informative for probing) — matching the
existing biography route.

## Building the link — `nodeUrl(id)`

[`nodeUrl`](../packages/content/src/shares.ts) (in `@mantle/content`, beside
`publicBaseUrl` / `shareUrlForToken`) returns the absolute permalink
`<origin>/n/<id>`. It's absolute so it survives outside the web request cycle —
Telegram, email — and the in-app chat renderer treats same-origin links as SPA
navigation (below). Origin comes from `MANTLE_PUBLIC_URL` → `NEXT_PUBLIC_APP_URL`
→ localhost, same as share links.

## Responder tooling

So responders link items without constructing URLs by hand, the read tools
return a `url` field and their descriptions tell the model to surface items as
markdown `[title](url)`:

- `search_nodes` — every hit carries `url` (the main discovery path).
- `node_read` — universal reader returns `url`.
- `note_get`, `page_get`, `todo_get`, `table_get`, `event_get` — each returns
  `url` alongside the row.

Because the tool descriptions carry the instruction, it propagates to **every
agent** that holds the tool with no manifest reseed (see
[`system-manifest/CLAUDE.md`](../apps/web/lib/system-manifest/CLAUDE.md) for why
that matters).

## Clicking through in chat

Responder replies render read-only through TipTap
([`rich-text.tsx`](../apps/web/components/assistant/rich-text.tsx)) using the
shared page-editor extensions, where `link.openOnClick` is **false** (correct
for the editable canvas, where a click places the cursor). The reply renderer
therefore intercepts link clicks itself:

- **same-origin** links (including `/n/<id>`) → the Next SPA router (no full
  reload),
- **external** links → a new tab (`noopener,noreferrer`),
- modifier-clicks / middle-clicks fall through to the browser.

The editable Pages canvas is untouched.

## The URL reflects what you're looking at

The permalink lands on `?selected=<id>`, but selecting another item *within* a
surface was pure client state — the URL went stale, so you couldn't copy a link
to the item currently open. [`syncSelectionParam`](../apps/web/lib/url-sync.ts)
fixes that: on each selection it rewrites `?selected=` via
`history.replaceState` — **no server refetch** (the item is already in client
state), no scroll reset, and no back-stack entry (Back leaves the surface rather
than stepping through every item you clicked).

Wired into **notes**, **lifelog**, and **todos** (the surfaces whose detail is
held client-side). **Tables** and **contacts** are left as-is — their detail
loads server-side on select, so they genuinely need `useListNav().go`
navigation, and already reflect the selection in the URL.

## Files

- `apps/web/app/(app)/n/[id]/page.tsx` — the universal permalink route.
- `packages/content/src/shares.ts` — `nodeUrl()`.
- `packages/tools/src/builtins*.ts` — `url` fields + link instructions on the
  read tools.
- `apps/web/components/assistant/rich-text.tsx` — chat link-click handling.
- `apps/web/lib/url-sync.ts` — `syncSelectionParam` (replaceState).
