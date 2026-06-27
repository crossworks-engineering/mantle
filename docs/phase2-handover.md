# Phase 2 (FE/BE split) — Live Handover

Continuation doc for a fresh context. Read this first, then `docs/client-data-fetching.md`.
**Branch:** `feat/dedicated-api-runners` · **Version:** `0.63.10` · **PR:** crossworks-engineering/mantle#1 (open, all work pushed).

## The mission (unchanged)

Split `apps/web` from a full-stack app into a **pure client + an HTTP API**, to unlock
(1) an **Electron desktop client** and (2) **DB-less local dev**. The blocker was that
RSC pages + server actions read `@mantle/db` in-process. See `docs/frontend-backend-split.md`
for the original why + full task list.

## Where we are

| Phase 2 task | Status |
|---|---|
| **Task 1** — close every `@mantle/db` hole behind an HTTP endpoint | ✅ done (v0.60.x). Checklist `docs/phase2-task1-api-gaps.md`. |
| **Task 2** — bearer auth across `/api` | ✅ effectively done. `requireOwner`/`getOwnerOr401` fall through to `getBearerUser`; `apiFetch` bounces to `/login` on 401/redirect. |
| **Task 3** — DB-less dev | ✅ foundation (v0.61.0). Seam `apps/web/lib/remote-data.ts` (`MANTLE_REMOTE_API`). Doc `docs/db-less-dev.md`. |
| **Task 4** — convert screens to client data-fetching | 🚧 **almost done — only `/inbox` left** (see bottom). |
| Task 5 — Electron shell | ⬜ not started |
| Task 6 — absorb `apps/agent` into `apps/api` | ⬜ not started (Phase 1 carryover) |

### Task 4 — screens converted (ALL but `/inbox`)

**Settings (all done):** skills · tools · tool-groups · ai-workers · agents · heartbeats ·
profile · discover · microsoft · accounts.

**Content (done):** pages (+`[id]`) · notes (+`[id]`) · todos · events (+`[id]`) ·
contacts · tables (+`[id]`) · lifelog.

**Only `/inbox` remains** of the entire `(app)` surface. It is NOT a mechanical conversion —
detailed plan at the bottom.

Data layer = **TanStack Query v5**. Full pattern + the accumulated per-archetype notes:
**`docs/client-data-fetching.md` (READ THIS FIRST).**

## The conversion recipe (per screen) — proven across 17 screens

1. **Extend the list GET** if needed: most list endpoints only took `q`/`tag`. Add `sort` +
   `page`/`limit`/`offset` and return `{ items, total, page, pageSize, tags? }`, replicating the
   old server page's logic (incl. defaults — see the todos status-default gotcha below).
2. **Page → data-free**: `await requireOwner()` then render the client component with NO data
   props. Wrap in `<Suspense fallback={<Spinner/>}>` whenever the client uses `useSearchParams`
   or `useListNav` (it uses useSearchParams) — else `next build` errors with a CSR bailout.
3. **Client reads the URL** (`useSearchParams`) for `q`/`tag`/`sort`/`page`/`selected`/… and keys
   a `useQuery(['items', {q,tag,sort,page}])` off them, so an existing `go()`/`<Link>` navigation
   re-fetches automatically. `placeholderData: (prev) => prev` keeps the list visible while paging.
4. **Loading/error gate** AFTER all hooks, before the main return: `isPending` → `<Spinner>`;
   `isError && !data` → message + Retry. (Use `&& !data` so background refetch errors don't blank
   the screen.)
5. **Mutations**: most content screens ALREADY do create/save/delete via client `fetch` — just swap
   their `router.refresh()` (and any `useRealtime(..., router.refresh)`) for
   `queryClient.invalidateQueries({ queryKey: ['items'] })`. For settings forms, convert
   server-actions → `apiSend` + invalidate.
6. **Deep-linked detail** (`?selected=`/`?id=`) that may sit outside the current page slice → a
   secondary `useQuery(['items', id], …, { enabled: !!id && !inList })`. If list row and detail are
   the SAME shape (contacts), use the list row directly and only fetch on miss.
7. **Rich editor detail** (`/pages/[id]`, `/tables`, `/events/[id]`): outer query-gate component +
   inner editor that seeds `useState`/refs from `initial` (mounts only after the fetch). Out-of-band
   refreshes (AI assist, commit) → `invalidateQueries(['items', id])`.
8. **Delete unused server actions.** Move any server-side side-effects (cache clears, etc.) into the
   endpoint.
9. **Verify**: `pnpm --filter @mantle/web run typecheck` (the pre-commit gate). Then commit +
   `pnpm version:bump patch` + push (cadence below).

## Hard-won gotchas (don't relearn these)

- **`useSearchParams` needs `<Suspense>`** around the client component in the server page, or
  `next build` fails (CSR bailout). Every URL-driven screen here is wrapped.
- **Local optimistic list** (todos, events): don't rip out the local `useState` list — seed it from
  the query in a `useEffect` keyed on `listQuery.data` (+ deep-linked row), keep the optimistic
  `setX`, and `invalidate` on mutate (refetch re-runs the seed effect to reconcile).
- **Status/filter default mismatch** (todos): the page defaulted `status='open'` while the GET
  defaults to `'all'` — the client must send `status` explicitly.
- **Extracting a list filter to `const opts = {…}`** drops call-site contextual typing → annotate
  narrowed union vars (`status: TodoStatus | 'all'`) or the spread re-widens them to `string`.
- **JSON dates**: row `Date` columns arrive as ISO strings over HTTP. `formatDateTime` accepts
  strings. Watch components typed `internalDate: Date` (e.g. `EmailRow`) — convert with `new Date()`
  or loosen the prop.
- **client-types stays zero-dep**: never value-import `@mantle/db` in a client component (drags
  `postgres`/`Buffer`). Type-only imports are erased and fine.
- **Auth on client fetch**: `apiFetch` already detects 401 + followed redirect-to-`/login` and
  bounces — don't re-implement.
- **zsh quoting**: paths with `(app)` / `[id]` need quoting in Bash calls (globbing).
- **Don't run a 2nd `next dev`**: collides on `.next` with the user's `pnpm start` stack (see
  `no-concurrent-next-builds` memory). New deps/workspace pkgs need a dev RESTART, not a rebuild.

## Verification status (important)

Everything is **typecheck-clean** (`@mantle/web` + `@mantle/client-types`) but **NOTHING has been
browser/runtime-smoke-tested** — a 2nd dev server collides on `.next`, and the app is the user's
running `pnpm start` stack (changes need a dev restart). After a restart, eyeball each screen:
list loads (brief spinner) → create/edit/save → delete-with-confirm + screen-specific bits.
**Highest-risk to test:** `/settings/microsoft` + `/settings/accounts` (OAuth/credentials),
`/pages/[id]` (editor autosave/commit + AI-assist apply), `/tables` (grid edit → draft → Commit →
CSV Import; switching tables since the selected table is its own query).

## Key files / reference points

- Client data layer: `apps/web/lib/api-fetch.ts` (`apiFetch`/`apiSend`), `components/query-provider.tsx`,
  `components/ui/spinner.tsx`, `lib/use-list-nav.ts` (`useListNav` → `go()` + `pending`).
- Shared wire types: `packages/client-types/src/index.ts` (Skill/Tool/ToolGroup/AiWorker/Agent/
  Heartbeat DTOs + server aliases for drift).
- Worked examples: `/pages` (URL-driven list + outer-gate editor), `/notes` (deep-link secondary
  query), `/todos` (local optimistic list), `/tables` (master-detail shell + separate detail query).
- UI conventions (MUST read before UI work): `apps/web/CLAUDE.md`, `docs/ui-style-guide.md`.
- Project memory: `api-service-phase2.md`, `commit-and-version-cadence.md`,
  `no-concurrent-next-builds.md`, `prod-db-dev-workflow.md`.

## THE LAST SCREEN: `/inbox` — detailed build plan

A 3-pane mail client. **Not** a mechanical list conversion — it touches the email-HTML
**sanitization security boundary**. Endpoints below already EXIST and cover most of it.

### Existing endpoints (verified)
- `GET /api/email/accounts` → `{ accounts }` (redactAccount[]: PublicEmailAccount; has id/address/provider/enabled…).
- `GET /api/email/messages?account=&folder=&unread=&limit=` → `{ messages }` (listMessages rows;
  each has id, fromAddr, fromName, subject, snippet, internalDate (ISO over the wire), isRead).
- `GET /api/email/messages/[id]` → `getMessageWithAttachments` result = `{ email, attachments }`.
- `PATCH /api/email/messages/[id]` body `{ read?: boolean, starred?: boolean }` → `{ ok }` (owner-scoped, idempotent).
- `GET /api/email/folders?account=` → `{ folders }` (folderFacets: `{ folder, count, unread }[]`).
- Attachments download: `/api/attachments/[id]` (unchanged).

### Sub-components (verified)
- `components/mail/mail-client.tsx`, `mail-nav.tsx`, `account-switcher.tsx` — ALL already `'use client'`.
  `MailClient` takes `accounts`, `currentAccountId`, `folders: FolderLink[]`, `folderTitle`, `tab`,
  `tabAllHref`/`tabUnreadHref`, `defaultCollapsed`, and **`listSlot`/`readerSlot` as `ReactNode`**
  (currently server-rendered and passed in).
- `MailAccount = { id, address, provider }` (account-switcher) — matches `navAccounts`; derive by
  mapping `GET /api/email/accounts` rows to `{id,address,provider}`.
- `components/email-row.tsx` — client-safe (Link + cn only). Props: `{ id, fromAddr, fromName,
  subject, snippet, internalDate: Date, isRead, selected, href }`. **GOTCHA: `internalDate` is typed
  `Date`** but the API returns an ISO string → pass `new Date(r.internalDate)` (or loosen the prop).

### The hard part: `components/reading-pane.tsx`
Currently a **Server Component** that:
- `import { sanitizeEmailHtml } from '@mantle/email'` (a VALUE from a server pkg → can't go to the
  browser bundle) and computes `bodyHtmlSafe` for a sandboxed `<iframe srcDoc>`.
- Uses server-action forms `setEmailStarred` / `setEmailReadStatus` from
  `app/(app)/email-actions.ts` for the star/read toggle buttons.

**Plan:**
1. **Move sanitization into the endpoint.** In `GET /api/email/messages/[id]`, compute
   `bodyHtmlSafe = email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml) : null` server-side and add it
   to the JSON. (Sanitization stays server-side — same security property, just at the API layer.)
2. **Make `ReadingPane` `'use client'`**, props `{ email, attachments, bodyHtmlSafe }` (drop the
   `@mantle/email` import; the `@mantle/db` `Email`/`EmailAttachment` types are type-only = fine).
   The iframe `srcDoc` rendering is unchanged. Replace the two server-action `<form>`s with `apiSend`
   PATCH mutations (`/api/email/messages/[id]` `{read}` / `{starred}`) + invalidate the message +
   folders queries (folder unread counts change). `internalDate` is now an ISO string → adjust the
   `<time>`/`formatDateTime` (already string-friendly).
3. Then `app/(app)/email-actions.ts` (`setEmailReadStatus`/`setEmailStarred`) may be unused — **grep
   for other importers before deleting** (it might be used elsewhere).

### Build `InboxClient` (new client orchestrator, replaces the SSR page body)
Reads the URL (`account`/`folder`/`tab`/`email`) via `useSearchParams`. Wrap the page in `<Suspense>`.
- **Gate 1 — no accounts**: `accountsQuery` empty → the "connect an account" prompt (move the JSX from
  the page).
- **Gate 2 — empty contact allowlist**: the page used `loadContactGate(user.id).isEmpty` (no
  endpoint). Either derive from `GET /api/contacts` (`total === 0`) or add a tiny
  `GET /api/email/contact-gate` → `{ isEmpty }`. Shows the "no contacts" nudge.
- Resolve `currentAccount` = `?account` if owned else first; `selectedFolder` = `?folder` if in facets
  else INBOX else first; `tab` = `?tab==='unread' ? 'unread' : 'all'`.
- Queries: `['email','folders',accountId]`, `['email','messages',{accountId,folder,tab}]`,
  `['email','message',selectedId]` (enabled when `?email` set).
- **Mark-read-on-select** (page did `setReadStatus` SSR on view): when `?email` is set, fire
  `PATCH {read:true}` once + invalidate folders (unread counts) — or rely on the selected-message
  fetch + a mark-read effect.
- Render `<MailClient … listSlot={<EmailRow list/>} readerSlot={<ReadingPane …/>}>` with the slots
  now CLIENT-rendered. Build `folders: FolderLink[]` + the `inboxHref(...)` helper (copy from the
  page) client-side. `defaultCollapsed`: read the `react-resizable-panels:collapsed` cookie via
  `document.cookie`, or just default `false` (MailClient persists its own state).

### Scope estimate
~2–3× a normal screen: 1 endpoint tweak (add `bodyHtmlSafe`), maybe 1 tiny new endpoint
(contact-gate), `ReadingPane` client rewrite (security-sensitive — review the sanitize move), and the
`InboxClient` 3-pane orchestrator. The other 16 screens were mechanical; give this one a focused pass.

## Other known follow-up (small, deferred)
- Relocate remaining type-only `@mantle/db` imports (persona-notes-editor, calendar-row, drives-list)
  into client-types so the Task-1 grep is 100% empty (cosmetic). agents-client already done.

## Cadence (from project memory — follow these)
- Commit each discrete change separately; **bump the version** by extent
  (`pnpm version:bump patch|minor`) — patch = a screen conversion/fix, minor = a new capability.
  **Don't tag** (tag-push is the publish event).
- **Push** updates PR #1. The user has been fine with continuous pushing this session; still, offer
  rather than assume on a fresh start.
- The user runs everything on **dev** and is fine with screens being disrupted mid-development.
- Versions this arc: settings 0.62.0–0.63.4 · pages 0.63.5 · notes 0.63.6 · todos 0.63.7 ·
  events 0.63.8 · contacts+tables 0.63.9 · lifelog 0.63.10. `/inbox` → 0.63.11.
