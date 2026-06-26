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

- **Query keys** = URL as an array: `['skills']`, `['skills', id]`, `['skills', 'backrefs']`.
- **Invalidate the broadest affected prefix** after a mutation; don't hand-patch the cache
  unless you need optimistic UI.
- **Errors**: `apiFetch` throws `ApiError` carrying the endpoint's `{ error }` message —
  surface it via `query.error.message` / mutation `onError` + `toast`.
- **Auth stays server-side** in the page (`requireOwner`); only data moves to the client.
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

Convert more by following the reference; order by Electron priority.
