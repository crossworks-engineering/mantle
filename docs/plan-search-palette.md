# Plan: global search palette (⌘K) — the web face of `/api/search`

_Written 2026-07-20. The hybrid search engine gained an owner HTTP endpoint in
v0.148.0 (`GET /api/search`, hardened in v0.148.1) and the mobile companion
consumes it (v1.8) — but the web app itself still has no human-facing search.
This plan adds it as a command palette, the way Notion/Linear do it._

## Why a palette (not a bar)

Zero permanent chrome in an already-dense shell, keyboard-first (⌘K is
unbound today — ⌘B/⌘J/⌘I are taken), and it grows into quick actions later
without redesign. A bottom bar is a mobile idiom; the companion covers mobile.

## What already exists (recon 2026-07-20)

- **cmdk 1.1.1 is installed** and `apps/web/components/ui/command.tsx` wraps
  it shadcn-style — including `CommandDialog` (Dialog + sr-only title),
  `CommandInput/List/Empty/Group/Item`. Zero new dependencies.
- **Shortcut pattern**: `components/app-shell.tsx` (~178–200) registers
  window keydown for ⌘B/⌘J with the input-focus guard
  (`isContentEditable || INPUT/TEXTAREA/SELECT`). Copy it for ⌘K.
- **Trigger home**: `components/layout/header.tsx` right-side group
  (`ml-auto flex items-center gap-1`) — magnifier ghost Button before the
  theme toggles. Works for the mobile header too (palette renders fine in a
  Dialog on small screens).
- **Fetch idiom**: `components/page-editor/mention-list.tsx` — `apiFetch` +
  `AbortController` + monotonic `seqRef` guard (race-safe); debounce is the
  `team-section.tsx` 300 ms `setTimeout` pattern. **`apiFetch` is mandatory**
  (detached-mode rule) — never raw `fetch`.
- **Navigation**: `app/(app)/n/[id]/page.tsx` resolves ANY owned node id to
  its surface (note → `/notes?selected=`, page → `/pages/<id>`, file →
  `/files?file=`, … default → `/nodes/<id>/history`). The palette does
  `router.push('/n/' + id)` and never needs per-type routing. Do NOT use the
  API's absolute `url` field in-app (it's origin-prefixed; SPA nav wants the
  relative path).
- **Nav quick-jump for free**: `components/layout/nav-items.ts` exports
  `ALL_NAV_ITEMS` (`{name, href, icon}`) — a static "Go to" command group.
- **Gap to fill**: no shared node-type → icon map exists (nav-items,
  journey action-icon, and mention-list each have partial ones).

## Design

One `CommandDialog`, one input, results in this order:

1. **Go to** (static, only while the query also matches a nav item name):
   nav rows from `ALL_NAV_ITEMS`, client-filtered, no fetch.
2. **Results** (dynamic, `mode=nodes`, `limit=20`): flat relevance order —
   do NOT re-group by type (grouping would silently reorder the ranking the
   engine worked for). Each row: type icon · `title` · muted one-line
   `summary` (when present) · muted relative `updatedAt` right-aligned ·
   a destructive-toned "superseded" hint when `supersededBy` is set
   (selecting such a row still opens it; a small secondary action "open
   newer copy" navigates to `supersededBy.id`).
3. **Passages** (v2, `mode=chunks`): a footer toggle (Tab or a segmented
   control) switches the same query to passage search — rows render the
   quoted `text` (serif), `nodeTitle · heading` above it, select → `/n/<nodeId>`.
   This is the first consumer of chunks mode anywhere.

States: <2 chars → hint copy; in-flight → subtle "Searching…" row (keep old
results rendered — no flicker); empty after response → `CommandEmpty` with
the query echoed; `ApiError` → one muted error row (401 already bounces via
`apiFetch`).

Style rules that bind: theme tokens only, paired fills
(`bg-accent`+`text-accent-foreground`), no hardcoded colors, shadcn
components only, sentence case. The palette is an overlay, exempt from the
URL-driven list-screen rule.

## Phases

**P1 — shared icon map.** `apps/web/components/search/node-type-icons.ts`:
`NODE_TYPE_ICONS: Record<SearchNodeType, LucideIcon>` keyed off
`SEARCH_NODE_TYPES` (from `lib/search-query.ts`, the API's own enum) +
`nodeTypeIcon(type)` with a safe default. Reuse lucide picks already
established in nav-items/journey (note→StickyNote, page→BookText,
file→File, email→Mail, task→CheckSquare, event→CalendarDays,
contact→Contact, journal→NotebookPen, telegram_message→Send,
documentation→BookOpen, branch→FolderTree, …). Record type = compiler
enforces coverage when the enum grows.

**P2 — the palette.** `apps/web/components/search/search-palette.tsx`
(client): `CommandDialog` + debounced (300 ms) seq-guarded `apiFetch` of
`/api/search?q=…&limit=20`, "Go to" group, results group per Design above.
cmdk owns arrow/enter; `shouldFilter={false}` on the results group (server
already ranked them). Extract the pure bits — relative-time label,
nav-item filter, palette-row mapping — into
`components/search/search-palette-helpers.ts` for colocated vitest
(house pattern: pure logic gets `*.test.ts`, components don't).

**P3 — wiring.** Open-state lives in the shell (`app-shell.tsx`): ⌘/Ctrl+K
listener with the existing input guard, magnifier Button in `header.tsx`
right group (`aria-label="Search"`), palette mounted once inside the shell
providers. Optional: a "Search…" row atop the sidebar filter input that
opens the palette (unifying the two search affordances).

**P4 — passages toggle** (`mode=chunks`), as designed above. Ship P1–P3
first; this phase is independent.

**P5 — release.** `pnpm --filter @mantle/web run typecheck` + new helper
tests + `pnpm verify`; changelog `docs/_changelog/0.149.0.md` ("Search
palette — ⌘K over the whole brain"); bump + branch → `--no-ff` merge + tag
per repo convention (worktree `scripts/new-worktree.sh search-palette`).

## Acceptance

- ⌘K (and the header magnifier) opens the palette anywhere in `(app)/`;
  Escape closes; typing in an input/editor never triggers it.
- "printer contract" returns relevance-ordered mixed-type rows in <400 ms
  perceived (debounce included); Enter on a row lands on the right surface
  via `/n/<id>`; superseded rows are flagged.
- Works in light/dark and across color themes (tokens only); mobile: opens
  from the header, usable in the Dialog.
- A stale response can never render over a newer query (seq guard), and no
  fetch fires under 2 chars.
- Typecheck + verify green; no new dependencies.

## Later (explicitly out of scope now)

- Quick actions in the palette ("New note", "New task") — natural growth,
  needs create-APIs wiring.
- `type:`/`tag:` query operators mapping to the endpoint's `type`/`tags`
  params.
- Recent-searches / frecency (localStorage, like `lib/nav-usage.ts`).
- Companion bottom-bar restructure — separate decision, separate plan.
