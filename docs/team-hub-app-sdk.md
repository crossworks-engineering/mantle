# Team Hub apps — the builder's guide

How to build, structure, and maintain a **team hub app**: the mini-app a brain
designates to render as its Team Hub (served at `/hub` since the Team Workspace took over `/team`) for external team members. This is the
canonical reference for hub-app authors (human or agent). It builds on the
general mini-app reference — read
[app-authoring-guide.md](app-authoring-guide.md) first for the build loop,
allowed imports, and styling rules; this document covers what is *specific* to
hub apps: the `host.hub` SDK, the designation lifecycle, the structure to
follow, and the content-update patterns.

---

## 1. What a hub app is

An ordinary `/apps` mini-app plus one namespace. When designated (Team admin →
"Hub app"), the `/hub` shell renders it full-bleed for authenticated team
members. The shell keeps everything that must stay core:

- the **member token gate** and cookie minting/revocation,
- the **live Team Chat**,
- the **in-hub briefing reader** (team-shared pages),
- per-member **access logging** and membership liveness checks.

The app is presentation + app-local state. It talks to the shell through a
deliberately **thin, enumerated, host-mediated** API — data flows down, intent
flows up, and no token or capability handle ever enters the iframe. The
sandbox is unchanged from ordinary mini-apps: opaque-origin iframe, no
network, no cookies; the only egress is the postMessage bridge.

**The built-in hub is the safety net.** If the designation chain breaks at any
link — pref unset, app deleted, build red, share revoked, bundle fails to fetch
*or* fetches but never boots — members get the built-in hub. Designation can
never cost a team a working page.

## 2. The designation chain (how `/hub` decides what to render)

```
prefs.teamHubAppId  →  app exists under this owner
                    →  green PUBLISHED build
                    →  active TEAM-mode share
```

Designation (the Team-admin picker, or `PUT /api/team-admin/hub-app`) ensures
the app's share exists and is team-mode, then sets the pref. Undesignating
clears the pref only. Members are always served the **published** build —
drafts never leave the owner editor.

Brokered traffic (bundle, tool calls, SQLite) goes through the app's team-mode
share routes, so the member's identity is re-derived server-side on every call
and every access is logged per member.

## 3. The `host.hub` SDK

```ts
import { host } from '@host';

host.hub.get(): Promise<HubData>    // REJECTS off the /team surface
host.hub.openChat(): void           // shell switches to live Team Chat
host.hub.openBriefing(token): void  // shell opens the in-hub reader

type HubData = {
  siteName: string | null;   // brain's site-name pref
  memberName: string | null; // signed-in member's display name
  version: string;           // platform version (footer chrome)
  sections: Array<{          // = the owner's active team-mode page shares,
    token: string;           //   share-time ordered — the briefing cards
    title: string;
    icon: string | null;
    summary: string | null;
    updatedAt: string;       // ISO
    parentToken: string | null; // nearest team-shared ANCESTOR page, or null
                                 //   for a top-level page. Nest a shared subtree
                                 //   under its parent; null = a top-level card.
  }>;
  counts: Record<string, number>; // whitelisted coarse content counts,
                                  // zeros included — you decide what to hide
};
```

Rules that bind the SDK (and any future addition to it):

- **Enumerated, host-mediated, data-down / intent-up.** New capabilities are
  new enumerated kinds in `apps/web/lib/app-bridge/protocol.ts`, mirrored in
  the `@host` kit string (`packages/app-build/src/kit.ts`; drift tripwire:
  `kit.test.ts`) — never a generic passthrough.
- **Chat and the reader are shell views.** The app opens them; it never
  embeds, restyles, or intercepts them.
- **`openBriefing` only opens real sections.** The shell validates the token
  against the current `sections`; anything else is ignored. Deep-link by
  *finding* a section (e.g. by title match), never by hardcoding a token.
- **`hub.get` is answered locally by the shell** from the `/api/team/hub`
  payload — extending `HubData` means extending that route, where it is gated
  and audited.

Call the SDK defensively — `host.hub?.get` — so the same bundle renders on a
box whose runtime predates the namespace.

## 4. Project structure

A hub app is a virtual file tree (max 50 files / 256 KB each). Follow this
shape so any agent can pick up any hub app cold:

```
App.tsx              ← entry: export default function App(). Wiring ONLY:
                       hub.get + preview fallback + section composition.
content.ts           ← THE CONTENT LAYER: what's-new tiles, hero copy,
                       stat labels. Editing this file is the common update;
                       keep it free of logic so diffs are pure content.
components/Hero.tsx      ← presentational sections, one file each
components/WhatsNew.tsx
components/Briefings.tsx
components/Stats.tsx
lib/format.ts        ← helpers (dates, numbers). No side effects.
```

Conventions:

- **Entry stays thin.** `App.tsx` fetches `HubData`, holds the
  preview-fallback state, and composes sections. All copy lives in
  `content.ts`; all markup in `components/`.
- **One component per section**, taking `(hub, content)` as props — so a
  restyle touches one file and a content edit touches none of the markup.
- **`data-app-region` on each section** (`hero`, `whats-new`, `briefings`,
  `stats`) — the editor's inspect mode and agent annotations key off these.
- **Off-hub preview is mandatory** (SDK rule R2): `hub.get` rejects in the
  `/apps` editor — catch it and render labelled placeholder data. Never gate
  the whole render on `hub.get`.
- Theme tokens only, literal class strings, `h-full` viewport layout — the
  general rules from the authoring guide all apply.

(The first hub app was authored single-file for bootstrap speed; multi-file is
the standard from here. Split on the next substantive edit, not as a special
task.)

## 5. Content patterns — choose how the hub updates

Three tiers, from simplest to most dynamic. Most hubs should start at Tier 1
and adopt Tier 2 only for content that changes more often than the layout.

### Tier 1 — content in code (update = publish)

Tiles, copy, and layout live in `content.ts`. An update is
`app_source_set → app_build → app_publish` — about a minute, no platform
release. This is deliberately correct for hub apps (the app IS the content
layer) and it's version-controlled by the app's draft/publish flow.

**Choose this when** updates are occasional (release highlights, reworded
copy) and made by the owner's agent anyway.

### Tier 2 — tiles from a brain Table (update = edit the table; no publish)

The "what's-new boxes as data" pattern. The app declares one **builtin
read tool** and renders rows:

1. Create a Table (e.g. "Hub — What's new") with columns:
   `Title` (text) · `Blurb` (text) · `Icon` (text — a lucide name from a fixed
   allowlist) · `Accent` (number 1–5) · `Order` (number) · `Active` (checkbox).
2. Declare the tool: `app_tools_set(id, ['table_rows_list'])`.
3. In the app:

```tsx
const [tiles, setTiles] = useState<Tile[] | null>(null);
useEffect(() => {
  host.tools
    .call('table_rows_list', { table_id: WHATS_NEW_TABLE_ID })
    .then((r) => setTiles(parseTiles(r)))        // validate + filter Active,
    .catch(() => setTiles(FALLBACK_TILES));      // sort by Order, cap at N
}, []);
```

4. Map `Icon` through a **literal allowlist**
   (`{ cloud: Cloud, shield: ShieldCheck, … }`) and `Accent` through literal
   class strings (`['bg-chart-1/15 text-chart-1', …]`) — Tailwind cannot see
   computed class names, and an allowlist means a typo in the table degrades
   to a default icon instead of a broken tile.
5. Updating the boxes is now `table_row_add` / `table_row_update` /
   `table_cell_set` → `table_commit` — over MCP, by chatting with the brain,
   or in the product UI. **Live on the next hub load, with no app_publish at
   all.**

Notes that keep this safe and honest:

- `table_rows_list` is a **builtin**, so it passes the team broker's
  builtin-only gate; it runs under the *owner's* scope and is access-logged
  per member. It reads the **published** table — draft edits stay invisible
  until commit, which gives table updates the same review step as app
  publishes.
- The table id is pinned in `content.ts`. That's fine: ids aren't secrets and
  the call is broker-validated.
- Always ship `FALLBACK_TILES` — a broker hiccup must degrade to sensible
  static content, not an empty section.

**Choose this when** the boxes change weekly or are curated by someone who
shouldn't need the app tools at all (they just edit a table, or ask the brain
to).

### Tier 3 — per-app SQLite for member interactivity

Read-acknowledgements, polls, per-section feedback: declare a schema with
`app_db_schema_set` (idempotent DDL, bump `schemaVersion` on change) and use
`host.db.query/exec`. Team members' writes are allowed and access-logged.

**The attribution caveat (do not skip):** the app runs in the member's
browser, so a `memberName` you write into SQLite is *advisory* — display it,
but never build permission or integrity logic on it. The host's per-member
access log is the tamper-proof trail. Server-stamped writes (a reserved
`$member_contact_id` binding substituted by the team db-broker) are the
planned upgrade; until then treat member-attributed rows as honest-majority.

## 6. The manifest, today and next

A hub app's manifest is the ordinary app manifest:

```ts
{
  toolSlugs?: string[];   // brokered tool allowlist (Tier 2). Team surfaces
                          // additionally refuse non-builtin handlers.
  sqlite?: { schemaSql: string; schemaVersion: number };  // Tier 3
  description?: string;
}
```

There is deliberately **no** `hub` manifest block yet — designation lives in
the brain pref + share, not in the app, so any app can be tried as a hub and
reverted with one click. When hub apps need to declare capability requirements
(e.g. "requires hub.get v2 fields"), that belongs in a future
`manifest.hub: { requires: [...] }` block that the designation picker checks —
reserved, not implemented. Propose additions there rather than overloading
`description`.

## 7. Updating a live hub — the workflows

| Change | Workflow | Live when |
|---|---|---|
| Copy / tiles (Tier 1) | edit `content.ts` → `app_build` → `app_publish` | next member page load |
| Tiles (Tier 2) | edit table → `table_commit` | next hub load — no publish |
| Layout / new section | edit `components/` → build → publish | next page load |
| Briefing set / order | share or revoke team-mode pages (share time = order) | next hub load |
| Revert to built-in hub | Team admin → Hub app → "Built-in hub" | immediately |

Members with `/hub` already open see updates on their next load — there is no
live push to an open tab. The shell keeps the app mounted across chat/reader
round-trips, so in-app state survives navigation but not a reload; anything
that must survive a reload goes in SQLite (Tier 3).

## 8. Definition of done

1. Build green, published, designated; renders on `/hub` as a real member in
   light **and** dark.
2. Off-hub preview renders in the `/apps` editor (labelled, placeholder data).
3. Chat and every briefing open via `host.hub` and "back" returns to the app.
4. Tier 2 only: tiles render from the table; a broken/empty table degrades to
   the fallback set; icon/accent typos degrade to defaults.
5. No hardcoded colours; no undeclared tool slugs; versioned SQLite schema;
   no secrets or member tokens in the app db.
6. Token revocation locks the member out mid-session (host guarantee —
   verify, don't assume).

## 9. Troubleshooting

- **Members see the built-in hub instead of the app** — the chain broke.
  Check, in order: pref set (Team-admin picker shows the app), published build
  green (`app_get`), share active and team-mode. The picker labels a
  designated app whose build went red.
- **Members see "Loading…" then the built-in hub** — the bundle booted badly
  (module-level throw) or an import failed; the shell's ready-watchdog fired.
  Reproduce in the `/apps` editor, fix, republish.
- **`hub.get` rejects** — you're off the `/team` surface (editor, ordinary
  share, pre-rollout runtime). That's the R2 preview path, not an error.
- **A tool call returns 403** — the slug isn't declared via `app_tools_set`,
  or it's a non-builtin handler (team surfaces refuse those by design).
- **Tiles don't update after a table edit** — the draft wasn't committed;
  `table_rows_list` reads published rows only.
