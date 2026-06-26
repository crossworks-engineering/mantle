# Phase 2 (FE/BE split) — Live Handover

Continuation doc for a fresh context. Read this first, then the linked docs.
**Branch:** `feat/dedicated-api-runners` · **Version:** `0.63.0` · **PR:** crossworks-engineering/mantle#1 (open, all work pushed).

## The mission (unchanged)

Split `apps/web` from a full-stack app into a **pure client + an HTTP API**, to unlock
(1) an **Electron desktop client** and (2) **DB-less local dev**. The blocker was that
RSC pages + server actions read `@mantle/db` in-process. See `docs/frontend-backend-split.md`
(the original handover) for the why and the full task list.

## Where we are (what's DONE)

| Phase 2 task | Status |
|---|---|
| **Task 1** — close every `@mantle/db` hole behind an HTTP endpoint | ✅ done (v0.60.x). All 17 real holes closed; grep returns only comment/type-only false positives. Checklist: `docs/phase2-task1-api-gaps.md` |
| **Task 2** — bearer auth across `/api` | ✅ effectively done. `requireOwner`/`getOwnerOr401` already fall through to `getBearerUser`. `apiFetch` bounces to `/login` on 401/redirect. CORS for a separate origin = not needed yet (no separate origin). |
| **Task 3** — DB-less dev | ✅ foundation (v0.61.0). Server seam `apps/web/lib/remote-data.ts` (`MANTLE_REMOTE_API`); reference adopter `/settings/accounts`. Doc: `docs/db-less-dev.md`. Broader coverage falls out of Task 4. |
| **Task 4** — convert screens to client data-fetching | 🚧 **in progress** — 4 screens done (see below). This is the active work. |
| Task 5 — Electron shell | ⬜ not started |
| Task 6 — absorb `apps/agent` into `apps/api` | ⬜ not started (Phase 1 carryover) |

### Task 4 — screens converted so far
`/settings/skills` (v0.62.0, the reference) · `/settings/tools` (v0.62.2) ·
`/settings/tool-groups` (v0.62.3) · `/settings/ai-workers` (v0.63.0, the big one) ·
`/settings/agents` (the 6-source one; reused existing REST + added `/api/tailscale/peers`
and `/api/agents/[id]/test/chat`, deleting the last server action) ·
`/settings/heartbeats` (built the full mutation API — POST/PATCH/DELETE + `…/[id]/fire`
+ `/api/agents/options` + `lib/heartbeat-schema.ts` Zod — and deleted its server actions).

The data layer is **TanStack Query v5**. Full pattern + conventions:
`docs/client-data-fetching.md` (READ THIS before converting a screen).

## The conversion recipe (per screen)

1. **Page → data-free**: keep only `await requireOwner()` + render the client component. No data props.
2. **Types**: add the wire DTO to `@mantle/client-types` (zero-dep, zero-runtime) and alias the
   server summary to it (`export type XSummary = XDTO` in the lib) so drift is a compile error.
   No existing summary (raw rows)? add a `toXDTO(row)` mapper — its return type is the drift check,
   and it does ISO-date serialization. Never value-import `@mantle/db` in a client component.
3. **Reads**: `useQuery` with array keys mirroring the URL (`['skills']`, `['skills','backrefs']`),
   fetched via `apiFetch` (`apps/web/lib/api-fetch.ts`). Render `isPending` (→ `<Spinner>`),
   `isError` (→ message + Retry), empty, then data. Secondary data (badges) failing → subtle
   non-blocking notice, not a whole-screen error.
4. **Mutations**: `useMutation` → `apiSend(...)` → `queryClient.invalidateQueries({queryKey:[...]})`
   (replaces `revalidatePath`/`router.refresh`). Optimistic toggles: `onMutate` cache-swap +
   rollback in `onError` (see `/settings/tools`).
5. **No endpoints yet?** Build the API first (Task-1 style), in phases if large.
6. **Uncontrolled forms** (build `FormData` at submit): don't rewrite them — convert the FormData
   to JSON in a `lib/*-form.ts` helper the parent's mutation calls (see `lib/ai-worker-form.ts`).
7. **Delete** any now-unused server actions. Move server-side side-effects (cache invalidation, etc.)
   into the endpoint.
8. **Verify**: `pnpm --filter @mantle/web run typecheck` (the repo's pre-commit gate; `next lint` is
   deprecated/interactive here). Then commit (see cadence below) + version bump + push.

## Hard-won gotchas (don't relearn these)

- **Auth on client fetch**: `requireOwner` routes 307 to `/login`; `fetch` silently follows it, so
  a naive client renders an empty screen on expired session. `apiFetch` already detects 401 **and**
  a followed redirect-to-`/login` and bounces — don't re-implement per screen, but know it's there.
- **Port server-side side-effects**: e.g. ai-workers' embedding mutations call
  `clearEmbeddingModelCache`; the endpoints had to replicate that or model swaps lag ~60s. When you
  delete an action, grep its body for side-effects beyond the DB write.
- **JSON dates**: row `Date` columns arrive as ISO strings over HTTP. DTOs use `string`. `formatDateTime`
  already accepts strings. The `toXDTO` mapper is where you convert.
- **client-types stays zero-dep**: re-exporting a type from `@mantle/db` drags its node-typed graph
  (`Buffer`/`@types/node` errors) into the package. Define complex shapes standalone; the lib alias
  still catches drift.
- **zsh quoting**: paths with `(app)` / `[id]` need quoting in Bash tool calls (zsh globbing).
- **Don't run a 2nd `next dev`**: `pnpm start` (= `scripts/up.sh`) brings up Docker infra then
  `exec pnpm dev` (HMR on the host). New deps / new workspace packages / root-layout changes need a
  **dev restart** (not an image rebuild). A second `next dev` collides on `.next` — see the
  `no-concurrent-next-builds` memory.

## Verification status (important)

Everything is **typecheck-clean** and reuses proven endpoints, but **no screen has been
browser/runtime-smoke-tested by me** — a second dev server would collide on `.next`, and the
app is the user's running `pnpm start` stack (prod-ish: changes need a dev restart to show).
The user should, after a restart, eyeball each converted screen: list loads (brief spinner),
create/edit/save, delete-with-confirm, and any screen-specific bits (ai-workers: set-default +
the test buttons, which need real provider API keys).

## Key files / reference points

- Client data layer: `apps/web/lib/api-fetch.ts` (`apiFetch`/`apiSend`, base-URL + bearer ready),
  `apps/web/components/query-provider.tsx`, `apps/web/components/ui/spinner.tsx`.
- Shared wire types: `packages/client-types/src/index.ts` (Skill/Tool/ToolGroup/AiWorker DTOs).
- Reference conversions: skills (simplest), tools (2nd source + optimistic), tool-groups (cache reuse),
  ai-workers (full API build + 2178-line uncontrolled form + `lib/ai-worker-rpc.ts` + `lib/ai-worker-form.ts`).
- DB-less seam: `apps/web/lib/remote-data.ts`, `lib/data/email-accounts.ts`.
- UI conventions (MUST read before UI work): `apps/web/CLAUDE.md`, `docs/ui-style-guide.md`.
- Project memory: `api-service-phase2.md` (this whole arc), `commit-and-version-cadence.md`,
  `no-concurrent-next-builds.md`, `prod-db-dev-workflow.md`.

## Remaining Task-4 work (next targets)

Pages still SSR (read `@mantle/*` in-process). None has a *real* `@mantle/db` hole anymore
(Task 1 closed those), but they still server-render their data:

- **`/settings/accounts`, `/settings/microsoft`, `/settings/discover`, `/settings/profile`** — email/MS
  account + profile screens; some have endpoints from Task 1, some need the secondary ones.
  Likely the best next targets now that heartbeats is done.
- **Content screens** (`/notes`, `/pages`, `/todos`, `/events`, `/tables`, `/contacts`, `/lifelog`,
  `/inbox`) — the larger surface; most already have REST + client components that fetch for mutations.
  `/pages` was the doc's suggested template; order by Electron priority.

### Known follow-up (small, deferred)
- Relocate the remaining type-only `@mantle/db` imports (persona-notes-editor, calendar-row,
  drives-list) into client-types so the §6 grep is 100% empty (cosmetic). agents-client done.

## Cadence (from project memory — follow these)

- Commit each discrete change separately; **bump the version** by extent (`pnpm version:bump patch|minor`)
  — patch = a screen conversion / fix, minor = a new capability. Tag-push is the publish event — **don't tag**.
- **Push** updates PR #1 — the user has been asking explicitly each time; offer, don't auto-push unless told.
- The user runs everything on **dev** and is fine with screens being disrupted mid-development.
