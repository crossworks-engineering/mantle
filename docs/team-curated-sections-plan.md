# Team Hub — curated tag sections on the member Dashboard (plan)

Status: **implemented** (v0.152.0) — see docs/sharing.md §4 "Curated Dashboard
sections" for the canonical description. This file remains as the design
record.

## The feature

The owner picks a handful of tags on the admin Team screen. On the member
Dashboard (`/team` overview), each picked tag becomes a section listing up to
5 shared Pages carrying that tag, newest-updated first, each rendered as
**title + summary + link**. Both team-mode and public-mode shares qualify —
if it has an active share and the tag, it lists.

```
Engineering                     ← section per curated tag
  [Title]
  [1-2 sentence summary]
  [→ read]                      ← /s/<token>
  … up to 5

Features
  …
```

## Investigation findings — the hard parts already exist

**The summary "obstacle" is already solved.** Pages get a real 1–2 sentence
LLM summary at every commit: `page` is in the extractor's
`DEFAULT_EXTRACT_TYPES` (`apps/api/src/agent/extractor.ts:116`), and the
summary lands in `nodes.data.summary` (+ `summary_model`, `summary_at`)
via the `content_index` pass. The team-hub read layer **already returns it**:
`TeamVisibleShare` (`packages/content/src/team-hub.ts:235`) carries
`title`, `summary`, `updatedAt`, `tags`, and the share `token`.

The only gap: `commitPage` clears `data.summary` and re-queues extraction
(`packages/content/src/pages.ts:1100`), so between a commit and the extractor
finishing — or if extraction never ran — the summary is null. Fallback:
`pages.doc_text` (derived plaintext, kept current on every commit) — take the
first ~200 chars as an excerpt.

**The by-tag query already exists.** A tag section is literally one existing
call: `pageTeamVisibleShares(ownerId, 'page', { tag, sort: 'updated',
limit: 5 })` (`team-hub.ts:338`). Tags live on `nodes.tags text[]` (GIN
indexed), visibility on the `shares` table (`settings.mode` =
`'public' | 'team'`, one active share per node), and the visibility predicate
(`teamShareVisiblePredicate`, `team-hub.ts:265`) already admits both modes.

**Where things live.**
- Member Dashboard: `components/team-workspace/team-overview.tsx` — the
  curated sections slot in directly below the existing section-tiles grid.
  `/team` pages do no server-side DB reads; content comes via team-authed
  `/api/team/*` routes.
- Admin surface: `/team-admin` (`app/(app)/team-admin/page.tsx`). The exact
  precedent for "owner curates what members see" is the hub-app designation:
  a profile pref (`teamHubAppId`, `packages/content/src/profile-preferences.ts:180`)
  + `HubAppPicker` panel + a small owner-only API route.
- Members are contacts with a live `contact_team_tokens` row; they read
  content only through `/s/<token>`.

## Plan

### 1. Pref: `teamHubTags`

`teamHubTags?: string[]` in `profile-preferences.ts`, following the
`teamHubAppId` projection pattern exactly (typed field + read/write
projections). Cap at ~8 tags, deduped, lowercased on write. This is config,
not content — the share remains the single source of truth for *what* is
visible; the pref only chooses *which tag groupings get pinned* on the
Dashboard.

### 2. Data layer: one new function + summary fallback

`curatedTeamSections(ownerId, tags)` in `packages/content/src/team-hub.ts`:
for each tag run the existing per-tag query (`limit: 5`, `sort: 'updated'`),
return `[{ tag, items }]`, skipping tags with zero visible items.

Add the summary fallback inside the share query: left-join `pages` and select
`COALESCE(nodes.data->>'summary', LEFT(pages.doc_text, 240))` (excerpt
trimmed to the last whole word client-side or in SQL). This benefits every
existing team-hub consumer, not just the new sections.

### 3. API: `GET /api/team/curated`

New team-authed route (same `resolveTeamChatCaller` gate as `/api/team/list`)
returning `{ sections: [{ tag, items: [{ token, title, summary, updatedAt,
icon }] }] }`. A dedicated route keeps `/api/team/workspace` light and lets
the Dashboard lazy-load the sections independently.

### 4. Admin UI: "Dashboard sections" panel on `/team-admin`

A `DashboardTagsPanel` beside `HubAppPicker` in the Chats-tab aside:
- Tag multi-select sourced from `listTeamShareTags(ownerId, 'page')`
  (`team-hub.ts:384`) — shows each tag with its shared-page count, so the
  owner only picks tags that actually resolve to content.
- Ordered list (order = section order on the Dashboard), remove ×.
- Persists via a small owner-only PATCH route under `/api/team-admin/`
  (mirroring the hub-app route).

### 5. Member UI: `CuratedSections` in the Dashboard

Client component rendered in `team-overview.tsx` below the tiles grid,
fetching `/api/team/curated`. Per section: tag as a capitalized heading, then
up to 5 rows of title (link to `/s/<token>`), summary in muted text, relative
updated-at. Renders nothing at all when no tags are configured or no section
has items — zero footprint for brains that don't use it.

### 6. Docs + release

Update `docs/sharing.md` / team-hub docs with the curation model;
`pnpm version:bump minor`; merge.

## Deliberate scope choices

- **Pages-only in v1, but nothing pages-specific in the shape.** Tags and
  shares are node-generic, so extending sections to files/events/tables later
  is just widening the type filter in `curatedTeamSections` (or making it a
  per-section `types` option). The pref, API payload, and UI need no change.
  This delivers the "pin anything for the team by tagging + sharing it"
  vision without building a generic pinning system up front.
- **No new tables, no per-item pinning.** Tag + share *is* the curation
  gesture: to feature a page, tag it and share it; to unfeature, untag or
  unshare. This matches the hub's existing "the share is the single source of
  truth" principle and keeps the admin surface to one small panel.
- **No LLM calls anywhere in this feature** — summaries are reused from the
  existing ingest pipeline (cost-safety rule), and the fallback is pure SQL.
