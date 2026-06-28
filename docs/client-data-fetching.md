# Client data-fetching (TanStack Query)

Phase 2 · Task 4 of the frontend/backend split: convert screens from server-side
`await getData()` + `revalidatePath` to **client-side fetching** against `/api/**`,
so the same components are loadable by a detached client (Electron) and render with
no server-side DB access. Standardized on **TanStack Query v5**.

Reference conversion: **`/settings/skills`** (`skills-client.tsx`). Copy its shape.

## The pattern

**1. Make the page data-free.** It keeps the server-side auth gate and renders the
client component — no data props:

```tsx
export default async function SkillsPage() {
  await requireOwner();          // auth stays server-side
  return <><SetPageTitle title="Skills" /><SkillsClient /></>;
}
```

**2. Read with `useQuery`.** Query keys are arrays mirroring the URL. Fetch through
`apiFetch` (`lib/api-fetch.ts`) — relative + cookie auth by default, base-URL +
bearer when `NEXT_PUBLIC_MANTLE_API_BASE` is set (Electron / DB-less browser).

```tsx
const skillsQuery = useQuery({
  queryKey: ['skills'],
  queryFn: () => apiFetch<{ skills: Skill[] }>('/api/skills').then((r) => r.skills),
});
```

**3. Render the states SSR used to hide** — `isPending` (loading), `isError`
(with a Retry calling `query.refetch()`), empty, then data.

**4. Mutate with `useMutation`, then invalidate** (the client-side replacement for
`revalidatePath`). Invalidation is **prefix-matched**, so `['skills']` re-validates
both `['skills']` and `['skills', 'backrefs']`:

```tsx
const save = useMutation({
  mutationFn: (body) => apiSend('/api/skills', 'POST', body),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  onError: (e) => toast.error(e.message),
});
```

## Conventions

- **Types come from `@mantle/client-types`** — never duplicate a row shape in the client,
  and never `import` (value) from `@mantle/db` in a client component. Add the wire DTO to
  that package and alias the server summary to it (`type SkillSummary = SkillDTO`) so a
  drift between what the server returns and what the client expects is a **type error**.
- **Query keys** = URL as an array: `['skills']`, `['skills', id]`, `['skills', 'backrefs']`.
- **Invalidate the broadest affected prefix** after a mutation; don't hand-patch the cache
  unless you need optimistic UI.
- **Errors**: `apiFetch` throws `ApiError` carrying the endpoint's `{ error }` message —
  surface it via `query.error.message` / mutation `onError` + `toast`.
- **Auth is handled for you.** `apiFetch` detects a `401` *or* a followed redirect-to-`/login`
  and bounces the browser to `/login?next=…`. (The page also keeps a server-side
  `requireOwner()` gate for the initial load.) Don't re-implement this per screen.
- **Loading** → `<Spinner>` (`components/ui/spinner.tsx`). **Secondary/optional data** (badges,
  counts that aren't the primary content) → on error, show a subtle non-blocking notice with
  Retry rather than failing the whole screen (see the skills backrefs notice).
- **Provider**: `QueryProvider` wraps the app in `app/layout.tsx` — nothing to add per screen.

## Why no SSR initial data?

Pure client-fetch (no `initialData` from SSR) keeps the page free of any in-process DB
read, which is what makes the screen Electron- and DB-less-ready. The cost is a brief
loading state — which we want to handle explicitly anyway. If a screen later needs
instant first paint, hydrate `initialData` from a server fetch then; don't reach for it
by default.

## Status

| Screen | State |
|---|---|
| `/settings/skills` | ✅ converted (reference template) |
| `/settings/tools` | ✅ converted (+ second data source, optimistic toggles) |
| `/settings/tool-groups` | ✅ converted (reuses the `['tools']` cache) |
| `/settings/ai-workers` | ✅ converted (built the API first; 2178-line form kept uncontrolled) |
| `/settings/agents` | ✅ converted (6 data sources via existing REST; added tailnet-peers + test-chat endpoints) |
| `/settings/heartbeats` | ✅ converted (built POST/PATCH/DELETE/fire + `/api/agents/options`; JSON body from the controlled form) |
| `/settings/profile` | ✅ converted (new GET/PUT `/api/profile`; query-gate + inner form; live Intl preview) |
| `/settings/discover` | ✅ converted (endpoints existed; accounts gate client-side; scan = useQuery, promote = mutation) |
| `/settings/microsoft` | ✅ converted (built config + drives + mail + disconnect endpoints; sub-components self-fetch) |
| `/settings/accounts` | ✅ converted (endpoints existed; URL-driven master-detail → client; IMAP test/save + folder picker as mutations) |
| `/pages` (+ `/pages/[id]`) | ✅ converted (first content screen; mutations were already client-fetch — wired the initial loads + extended the list GET + backlinks endpoint) |
| `/notes` (+ `/notes/[id]`) | ✅ converted (same shape as /pages; extended the list GET; deep-linked note via a secondary `enabled` query; `[id]` is just a redirect) |
| `/tasks` | ✅ converted (status/priority filters; kept the local optimistic list, seeded from the query; extended the list GET with pagination) |
| `/events` (+ `/events/[id]`) | ✅ converted (window filter; local optimistic list like /tasks; the `useRealtime` callback → invalidate; small `[id]` outer-gate) |
| `/contacts` | ✅ converted (inline master-detail; list row IS the detail; deep-link `?id=` via secondary query; `go({})` refresh → invalidate) |
| `/tables` (+ `/tables/[id]`) | ✅ converted (master-detail shell; selected `TableDetail` is a separate query; grid editor's commit/import refresh → invalidate; `[id]` was already a redirect) |
| `/journal` | ✅ converted (same shape as /notes; mood/category/tag filters; deep-link via secondary query) |
| `/inbox` | ✅ converted (the last screen; moved `sanitizeEmailHtml` into the message GET as `bodyHtmlSafe`; `ReadingPane` → client with PATCH star/read mutations; new `InboxClient` 3-pane orchestrator + `GET /api/email/contact-gate`) |

Convert more by following the reference; order by Electron priority.

Notes from the conversions so far:
- **Shared caches**: a screen that needs another resource just queries its key
  (`['tools']`) — TanStack dedupes across screens, no prop-drilling.
- **Optimistic toggles**: for instant on/off switches, `useMutation` with
  `onMutate` (cache the previous value, set the new one) + rollback in `onError`.
  See `/settings/tools`.
- **New shared type** → add the DTO to `@mantle/client-types` and alias the server
  summary to it (`type XSummary = XDTO`). Keep the package zero-dep: define complex
  shapes (e.g. `ToolHandler`) standalone rather than re-export from `@mantle/db`
  (which drags its node-typed graph in); the alias still catches drift at compile.
  When there's no summary layer (e.g. ai-workers returns raw rows), add a
  `toXDTO(row)` mapper instead — its explicit return type is the drift checkpoint,
  and it's where ISO-date serialization happens.
- **Uncontrolled forms** (build a `FormData` at submit, like the worker form) needn't
  be rewritten: keep the FormData submit and convert it to JSON in a `lib/*-form.ts`
  helper the parent's mutation calls. Move any server-side side-effects (e.g. the
  embedding resolver-cache invalidation) into the endpoint so behavior is preserved.
- **Screens with no endpoints yet** (ai-workers) → build the API first (Task-1 style),
  in phases if large (CRUD, then RPCs, then the client), each independently shippable.
- **Multi-source screens** (agents reads 6: agents, keys, skills, tool-groups, tts
  workers, tailnet peers) → one `useQuery` per source, each keyed to its own URL,
  then derive view-model arrays (filter enabled / map to the option shape) in
  `useMemo`. Most sources already had a GET from earlier screens — only the two
  genuinely missing endpoints were built (`/api/tailscale/peers`, and the
  test-chat affordance `/api/agents/[id]/test/chat`, which replaced the last
  server action so the screen has zero server-action deps).
- **Mutable list + `router.refresh()`** (agents kept the list in `useState` and
  hand-upserted on save): replace the state with `agentsQuery.data ?? []` and the
  refresh with `invalidateQueries(['agents'])`. Track in-flight save with a plain
  `useState` boolean for `<SubmitButton pending>` (the optimistic upsert is dropped
  — invalidate refetches; a brief repaint is acceptable, matching the other screens).
- **Building the mutation API + Zod from scratch** (heartbeats had only GETs): put
  the create/update Zod schemas in a shared `lib/*-schema.ts` (both `POST` and the
  `[id]` `PATCH` import them) with a `toCreateInput`/`toUpdateInput` that converts
  wire shapes to the lib input (e.g. ISO `earliestAt` → `Date`) and forwards only
  present keys so a status-only `PATCH` doesn't clobber config. Pause/resume is just
  `PATCH {status}`; fire-now is a verb sub-route (`POST …/[id]/fire`).
- **Controlled forms** (heartbeats holds a `FormState` in `useState`, unlike the
  uncontrolled worker form) → build a typed JSON body inline at submit and `apiSend`
  it; no FormData round-trip needed.
- **SSR-only date formatting** (heartbeats threaded server-formatted `nextFireAt`
  through props solely to dodge a hydration mismatch): once the page is pure
  client-fetch there's no SSR pass to mismatch, so drop the prop and format inline
  with the shared `formatDateTime` (en-GB, browser tz).
- **Picker needs a wider set than an existing GET returns**: `/api/agents` lists
  only conversational roles, but heartbeats bind any agent → added a dedicated
  `GET /api/agents/options` rather than overloading the existing list endpoint.
- **Query gate + inner form** (profile): when form `useState` must seed from
  fetched data, split into an outer component that runs the query + loading/error
  gate and an inner form that takes the loaded data as props — the inner mounts
  only once data exists, so its `useState` initializers are correct (no
  seed-from-async-data effect dance).
- **Self-fetching leaf components** (microsoft mail-toggle / drives-list): instead
  of the parent fetching N children's data and prop-drilling, give each leaf its
  own `useQuery` keyed by id + mutations with optimistic `setQueryData`. The
  parent just lists ids. Mutations that need fresh server-derived state return it
  from the endpoint and write it into the cache.
- **`useSearchParams` needs Suspense** (microsoft / accounts read `?connected=`
  / `?selected=`/`?mode=`): wrap the client component in `<Suspense>` in the
  server page or `next build` errors with a CSR-bailout (see the
  deploy-preflight memory).
- **Live/expensive reads** (discover IMAP scan, microsoft drive discover, accounts
  folder probe): set `staleTime: Infinity` + `refetchOnWindowFocus: false` so a tab
  refocus doesn't silently re-run a slow probe; expose a manual Rescan via `refetch()`.
- **URL-driven master-detail → client** (accounts `?selected=&mode=add|edit|folders`):
  keep the exact URL semantics — `useSearchParams()` for the current view + `<Link>`
  for navigation (client nav updates the params → re-render). The list is one
  `useQuery(['email','accounts'])`; the folders pane lazily `enabled`s its own query
  off `mode==='folders'`. Wrap the client in `<Suspense>` (useSearchParams).
- **Two-intent form via `submitter`** (IMAP test vs save): keep one `<form onSubmit>`
  with two `type="submit"` buttons carrying `value="test"|"save"`; read
  `(e.nativeEvent as SubmitEvent).submitter?.value` to branch. Preserves native
  required-field validation while routing to one `useMutation`. `apiSend` throws on
  the 400 (probe/save failure) → surface `mutation.error`; a successful save
  `router.push`es to the list.
- **Content screen where mutations are already client-fetch** (`/pages`): the SSR
  part was only the initial load. Keep the URL-driven list (`q`/`tag`/`sort`/`page`
  via useSearchParams) and put those params IN the query key so a `go()` navigation
  re-fetches automatically; `placeholderData: (prev) => prev` keeps the list visible
  while paging. Swap the mutations' `router.refresh()` for
  `invalidateQueries(['pages'])`. For the rich editor (`/pages/[id]`), use the
  outer-gate + inner-component split (the editor seeds many refs from `initial`, so
  it must mount only after the fetch); its out-of-band AI refresh becomes
  `invalidateQueries(['pages', id])`, which re-renders the inner with fresh `initial`
  and triggers the existing remount effect.
- **Screen with a local optimistic list** (`/tasks` prepends-on-create, optimistic toggle):
  don't rip out the local `useState` list — seed it from the query in a `useEffect` keyed on
  `listQuery.data` (+ the deep-linked row), keep the optimistic `setTasks`, and swap
  `router.refresh()` for `invalidateQueries(['tasks'])` (the refetch re-runs the seed effect to
  reconcile). Two traps: (1) the page defaulted `status='open'` while the GET defaults to `'all'`,
  so the client must send `status` explicitly; (2) extracting a list filter to `const opts = {…}`
  drops call-site contextual typing — annotate the narrowed union vars (`status: TaskStatus |
  'all'`) or the spread re-widens them to `string`.
- **Server-only sanitisation at a security boundary** (`/inbox` `ReadingPane` rendered the
  email body via `sanitizeEmailHtml`, a VALUE from server pkg `@mantle/email`, into a sandboxed
  iframe). Don't move the sanitiser to the browser — move it INTO the endpoint:
  `GET /api/email/messages/[id]` now returns `bodyHtmlSafe` alongside `{ email, attachments }`, so
  the HTML is sanitised server-side exactly as before and the client just renders the trusted
  string (iframe stays as the second layer). The pane becomes `'use client'` with the `@mantle/db`
  `Email`/`EmailAttachment` types kept as type-only imports (erased, no `postgres`/`Buffer` drag),
  and its two server-action `<form>`s become `apiSend` PATCH mutations that invalidate
  `['email','message'|'messages'|'folders']`.
- **3-pane orchestrator** (`/inbox` `InboxClient`): chained queries (accounts → folders →
  messages) plus a deep-linked `['email','message',selectedId]` detail query. Two gates render
  client-side before the shell: no-accounts (connect prompt) and the contact allowlist being empty
  — the latter via a tiny `GET /api/email/contact-gate` → `{ isEmpty }` rather than deriving from
  `/api/contacts` `total`, because the gate counts email/domain ENTRIES (a contact with no email
  doesn't count). Mark-read-on-select (the SSR page did an unconditional `setReadStatus(true)` on
  view) is a `useEffect` keyed on `selectedId` with a per-id ref so a manual "mark unread" while
  viewing isn't re-clobbered. `INBOX_LIMIT` is a value export — don't import it into the client;
  omit `limit` and let the endpoint default match. Gate the messages query on `!foldersQuery.isPending`
  so the folder is resolved before the first fetch (else it lists every folder, then narrows to INBOX).
