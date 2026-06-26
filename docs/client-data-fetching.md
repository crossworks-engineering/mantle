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
