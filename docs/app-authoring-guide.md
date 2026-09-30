# Authoring Mantle mini-apps from an MCP client

How an external Claude (Claude Code / Claude Desktop, on your own subscription)
builds a Mantle `/apps` mini-app end to end through the Mantle MCP server, and
binds it to your real Mantle data.

> This file is the canonical reference. It is mirrored to an installable Claude
> Code skill at `~/.claude/skills/mantle-app-builder/SKILL.md`; keep the two in
> sync when you change the app platform.

## What a mini-app is

A mini-app is **real TSX**, bundled server-side by esbuild and rendered in a
**sandboxed, opaque-origin iframe** (no credentials, no same-origin). Its source
is a small virtual file tree stored on the app row (`{ entry, files }`, max **50
files / 256 KB each**). It reads and writes your data **only** through tools you
explicitly grant it and an optional per-app SQLite database.

## The build loop (MCP tools)

1. **`app_create(name, description?, icon?, tags?)`** → returns the app `id`.
2. **Author the source.** Either:
   - `app_source_set(id, entry, files)`, upload the **whole tree** at once
     (`entry` must be one of the keys in `files`); best when you wrote the app
     locally, or
   - `app_file_write(id, path, content)`, one file at a time;
     `app_file_delete(id, path)` to remove one (can't delete the entry).
3. **Grant data access** (see _Binding to data_ below):
   - `app_tools_set(id, tool_slugs)`, the runtime allowlist of tool slugs the
     app may call. The host refuses any slug not declared here.
   - `app_db_schema_set(id, schema_sql)`, optional per-app SQLite DDL.
   - `app_db_seed(id, table, rows, replace?)`, optional one-time bulk load of
     reference data into a declared table (atomic; ≤2000 rows/call, batch
     bigger sets).
4. **`app_build(id)`**: a failed compile **fails the call**, with every error's
   file/line/column in the error text. Fix the offending file and rebuild until
   it succeeds (success returns `{ build_ok: true, warnings[], bytes }`). A
   failed build never replaces the last good preview.
5. **Review** at `/apps/<id>` (the preview renders the draft build).
6. **`app_publish(id)`**: promotes the draft + its green build to live. Refuses
   without a successful build.

`app_get(id, include_source?)` reads an app back; `app_list()` browses them;
`app_delete(id)` removes one (irreversible, confirm first).

Drafts are isolated: every edit lands in the draft; the published app is
untouched until `app_publish`.

## Allowed imports (the bundler allowlist)

Only these resolve, esbuild **rejects any other bare import**:

- `react` (hooks, etc.)
- `@/components/ui/*`, `button`, `card`, `input`, `label`, `badge`, `separator`
- `cn` from `@/lib/utils`
- `lucide-react` icons
- `host` from `@host` (the runtime bridge, below)
- relative files within the app (`./lib/fmt`, etc.)

No `axios`, no `date-fns`, no arbitrary npm. Bring helpers as local files.

## The entry contract

The entry file **must** `export default function App() { … }`. Default entry
path is `App.tsx`.

## Layout: you get a full viewport, you own it

An app now renders in a **real full-screen viewport** (in the `/apps` preview,
the editor, and a shared link alike), not the old content-hugging box. **The
app decides its own size, layout, and scrolling.** So:

- A dashboard should fill the space: `h-full` (or `h-dvh`) from the root, its own
  internal scroll areas (`min-h-0` + `overflow-y-auto` on panes), sticky headers,
  sidebars, all fair game now.
- A small form or list doesn't have to fill it, render a centred column
  (`mx-auto max-w-md`) and let the rest be empty; that's fine.
- Viewport-height utilities (`h-dvh`, `min-h-screen`, `vh`/`vw`) are **real** here
  , use them. (The old guidance to avoid them applied to the previous
  auto-sizing frame and no longer holds.)
- `host.ui.resize()` is a legacy no-op; there's nothing to resize; the frame is
  the viewport.

## Styling: theme tokens only

Use theme classes so the app follows the user's live theme, **never hardcode
colours** (a hex value breaks on theme switch):

`bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`,
`bg-primary` + `text-primary-foreground`, `bg-muted` + `text-muted-foreground`,
`border`, and the chart ramp `chart-1`…`chart-5`. Compose with `cn(...)`.

## The `@host` runtime bridge

The app's only window onto the host. `import { host } from '@host'`:

```ts
await host.tools.call(slug, input)   // call a DECLARED tool; returns its result
await host.db.query(sql, params?)    // read from this app's own SQLite (opened read-only — DML here fails)
await host.db.exec(sql, params?)     // write to this app's own SQLite
host.ui.resize(heightPx)             // legacy no-op — apps get a real full-screen viewport now (see Layout)
host.ui.notifyError(message)         // surface an error to the host UI
host.ui.onAnnotate(fn)               // subscribe to inspector annotations
host.ui.holdReady()                  // keep the host's loader up (call while first rendering)…
host.ui.ready()                      // …until this: the app is ready to be seen
```

**Loading is the host's job.** The host shows its loader until the app has
mounted, painted, and its first `host.db` / `host.tools` calls have been
answered (it brokers them, so it can see them in flight), then fades the app
in. An app that loads data through the bridge needs nothing extra and should
not draw its own full-screen loading state. `holdReady()` / `ready()` are for
work the host can't see, such as a heavy client-side computation. The host
reveals the app after a few seconds regardless, so a missing `ready()` can't
hang it.

Everything is brokered by the parent over postMessage and executed server-side,
so the iframe never sees secrets or credentials.

## Binding to data: the important part

**First: many apps need no data binding at all.** A calculator, converter, or
visualizer whose logic is pure code ships with zero tools and zero database.
The tiers, simplest first: (1) pure code; nothing to wire; (2) fixed reference
data, seed the per-app SQLite once with `app_db_seed` (below); (3) live
external/owner data, a declared tool via `host.tools.call`. Don't reach for
tier 3 when tier 1–2 suffices.

A running app **cannot read your notes / tables / entities directly**. It can
only reach owner data via:

1. **`host.tools.call(slug, input)`**: and only for slugs you put in the app's
   allowlist with `app_tools_set`. These run server-side under your owner scope.
2. **Per-app SQLite** (`host.db`): app-local state, **not** the brain.

So to show your data in an app, you give it a tool that returns that data:

- **Declare a built-in tool** that returns what you need (`note_list`,
  `table_rows_list`, `table_query`, `search_nodes`, …). This is the only kind
  that works for **members**: members running a team app get built-in tools
  only (a share link gets no tools at all).
- **Admin-only apps** may also use a purpose-built tool from the Toolsmith
  MCP tools: `recipe_tool_create` composes existing tools into one tool that
  returns exactly the shape the app needs; `api_tool_create` wraps an
  external HTTP API. Members and share links are refused these (a recipe,
  http or shell tool runs under the brain), so never give one to an app you
  set to team level or share.

Then `app_tools_set(id, ['that_slug'])` and call it from the app. For an app at
team level or lower the result carries `warnings`: one per declared tool the
app's level refuses (see "Team apps" below).

**An app's tools never read above its level, whoever runs it.** Every run,
yours included, uses the rules of the lower of the runner's level and the
app's: an admin-level app runs any declared tool; a team-level app the member
rules below (also when an admin runs it); a client-level app the client rules
(only `client_shared_list`, `client_shared_search` and `client_shared_open`,
on the client role, for admins and members too); a public app no tools at
all. What a tool returns can end up in the app's shared database, which
everyone at the app's level reads. Only the owner authors apps: the app write
tools refuse a team or client surface.

**Recommended flow (this is the synergy):** first _explore the data yourself_
with your own MCP read tools (`search`, `table_list`, `note_list`, …) to learn
its real shape; then pick the built-in tool that returns it (or, for an
admin-only app, mint a recipe tool that returns precisely that); then build
the app against it. You're binding the app to data you've actually inspected, so
the queries are correct, not guessed.

## Per-app SQLite

For app-local state (caches, user-entered rows, preferences). Declare DDL via
`app_db_schema_set(id, "CREATE TABLE IF NOT EXISTS …")`; the host provisions the
DB on first use. At runtime use `host.db.query/exec`. `ATTACH`, `DETACH`,
`VACUUM` and every `PRAGMA` except `table_info` / `table_xinfo` are blocked.
Each statement may run 5 seconds at most and return 50,000 rows and 8 MB at
most (add a LIMIT, select fewer columns or aggregate), and no single string or
blob may pass 16 MiB. The whole database file may hold 256 MB
(`APP_SQL_MAX_DB_MB`): a write past it fails with "database or disk is full"
and rolls back. Each member login, client login or share link runs one
statement at a time, and the next waits its turn (a burst of more than 16 at
once answers 429 busy), so prefer one query that joins over many small ones.
The
declared schema runs under the same rules as one transaction (30 seconds at
most): a script that fails anywhere applies nothing. Treat schema as **append-only**: there
are no destructive migrations; add columns/tables, use views for renames.

**Seeding reference data**: when the app needs pre-loaded lookup data (a
reference table, a rate matrix, rows imported from a spreadsheet), load it at
authoring time with `app_db_seed(id, table, rows, replace?)`: an atomic bulk
INSERT validated against the live table columns (values: string / number /
boolean / null; ≤2000 rows per call, batch bigger sets, `replace: true` on
the first batch only). Read the source data with your own read tools
(`file_read`, `table_rows_list`, …), transform, seed, then verify with
`app_db_query`. This is a one-time authoring step, **not** an integration,
don't mint a tool or build an import UI for it, and don't ship an app that
asks its user to paste in its own reference data.

Each app gets **one durable SQLite file**, isolated per app; there's no path
input, so an app can only ever reach its own database. Operationally it's a
first-class store: it runs in **WAL mode** (concurrent readers don't block a
writer; matters when an app is shared with several people, or the assistant
reads it while the app writes), and it's **included in the backup**
(`scripts/db-dump.sh` snapshots every app DB alongside the Postgres dump with a
consistent `VACUUM INTO`). App-authored data is real data, and it's protected
like the rest of the brain.

## Exporting app data to a Table (the app as master)

When a team manages data **inside** an app (Tier 3 SQLite with member writes),
the brain can keep a **Table** as a live, read-only view of one app table:

```
app_table_export_set(id, table, title?)   → creates the Table + the link
app_table_export_remove(id, table)        → dissolves the link
```

Direction of authority: **the app is the master.** After an app write
(`host.db.exec`, member or owner, and `app_db_seed`) the platform
re-materializes the Table from the SQLite rows — debounced, hash-gated (an
unchanged table never re-commits), pure SQL, no LLM. An app at client level
re-commits at most once every 10 minutes, and the Table of an app clients
write is indexed at retrieval depth only (no facts or entities from client
text). Typed columns derive
from the SQLite declared types (INTEGER/REAL → number, BOOLEAN → checkbox,
DATE/DATETIME → date/datetime, else text).

While linked, the Table is an **app table**: it refuses every grid edit from
the Tables side (rows, cells, columns, tabs, delete — `AppBoundTableError`);
title/tags/icon/sharing stay editable, and the `appLink` field on the table
DTO carries the badge. Removing the link (or deleting the app) frees the
Table as an ordinary editable table holding the last synced rows.

Choose the direction deliberately, one master per table, ever:

- Data managed **in the app** → export it out with `app_table_export_set`.
- Data managed **in Tables** → keep the table ordinary and declare a read
  tool for the app (the hub Tier-2 pattern). Never both on one table.

(If the assistant only needs to _query_ the data, no export is required at
all — see the next section.)

## Reading app data from the brain (the assistant can query your apps)

The user's **assistant can read any of their apps' databases**: the responder
holds two read-only tools, `app_db_list` (which apps have a DB + their tables)
and `app_db_query` (a `SELECT` against one app by id). So data an app stores is
answerable in normal conversation: _"how many open items in my tracker app?"_,
_"what's in the inventory table?"_, no extra wiring by you, the author.

Two things follow for how you design an app's schema:

- **Give tables and columns clear, self-describing names.** The assistant reads
  the live schema (`sqlite_master`) to know what to query, so `tasks(title,
status, due_at)` is far more useful to it than `t(a, b, c)`.
- **It is strictly read-only**: the database is opened read-only, so no query
  the assistant runs can ever mutate your app's data. (Writes still come only
  from the app itself via `host.db.exec`.)

This is on by default for all the user's apps, the brain/team is the trust
boundary, so there's no per-app "make readable" switch.

## Worked example: "My Notes" app

1. Mint the data tool (Toolsmith):
   `recipe_tool_create` → a `app_recent_notes` tool that calls `note_list` with
   an optional `query` and returns `[{ id, title, summary }]`.
2. `app_create("My Notes", "Browse my notes", "📝")` → `id`.
3. `app_tools_set(id, ["app_recent_notes"])`.
4. `app_source_set(id, "App.tsx", { "App.tsx": <below> })`:

```tsx
import { useEffect, useState } from 'react';
import { host } from '@host';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type Note = { id: string; title: string; summary: string | null };

export default function App() {
  const [q, setQ] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    host.tools.call('app_recent_notes', { query: q }).then((r) => setNotes(r.notes ?? r));
  }, [q]);
  return (
    <div className="p-4 space-y-3 bg-background text-foreground">
      <Input placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
      {notes.map((n) => (
        <Card key={n.id} className="p-3">
          <div className="font-medium">{n.title}</div>
          {n.summary && <div className="text-sm text-muted-foreground">{n.summary}</div>}
        </Card>
      ))}
    </div>
  );
}
```

5. `app_build(id)` → fix any errors → `app_publish(id)`.

## Gotchas

- **No `export default function App()`** → blank render. Always export the entry.
- **Disallowed import** → build error. Stick to the allowlist; inline helpers.
- **Hardcoded colours** → looks wrong on theme switch. Theme tokens only.
- **Calling a tool not in the allowlist** → 403 at runtime; `app_build` also
  surfaces undeclared `host.tools.call(slug)` as a warning. Declare first.
- **Expecting direct brain access** → there is none. Go through a declared tool.
- **Destructive SQLite migration** → unsupported. Schema is append-only.

## Sharing an app

A **published** app can be shared at an unguessable, revocable, full-screen URL
via the **Share** control on the app header. A link is always public: team
links were retired (member logins Phase 6 stage 6). Your team runs the app
from their own member logins instead (see "Team apps" below).

### Public (anyone with the link)

Anonymous visitors. A public app can use **only its own SQLite database, and
only for reads** (`host.db.query`). It gets **no brain tools at all**: every
`host.tools.call` is refused on a public link, and `host.db.exec` (writes) is
blocked. This is deliberate and enforced server-side: the whole brain is private
data, and there's no way to expose a _slice_ of it safely to the anonymous
public, so the answer is "none." A public app is a self-contained, read-only
view over data it already holds (or data baked into its bundle).

> This changed: earlier, a public link could invoke an app's declared tools.
> It can't anymore; declaring a data tool does nothing for a public share.
> If your app needs brain data, it is for **members**: set the app to team
> level and they run it from their own login.

### Team links (retired)

A team link used to ask the visitor for a **team token** (a Contact's code),
then let the app use its declared tools and write to its SQLite, audited to
that Contact. Team links were retired in member logins Phase 6 stage 6: every
one was revoked (migration 0176), an old one shows a "Sign in as a member"
page, and a member login does all of it now, audited to the login.

**Rule of thumb:** a link = "a read-only view of this app's own data, safe for
anyone"; a member login = "identified, audited teammates who may use my tools
and write data." Treat any share link as a secret; revoke by turning the share
off.

## Team apps (members run them)

Members (member logins, [member-logins.md](member-logins.md) section 7) run
apps from their own shell. Set the app's level to **Team** (its Access
control) and publish it; members then find it under Apps. They run the
PUBLISHED build only and never edit it.

- **Tools:** a declared **read-only built-in** tool that an enabled tool
  group at team level or lower holds (usually `team-read`), with no
  confirmation. It runs at the team level: it reads team-, client- and
  public-level items, never admin ones. Recipe, http, shell and MCP tools are
  refused, so are built-ins that write, and so are `my_items_list`,
  `my_item_open`, `summarize_text`, `search_chunks`, `team_request_create`
  and `read_result`. `app_tools_set`, `app_publish` and `access_set` list a
  warning for each declared tool members would be refused.
- **Data:** `host.db.query` and `host.db.exec` both work on a team- or
  client-level app (unless an admin marked it informational); on a
  public-level app members only read. The database is shared
  by the whole team (not one per member): design for that (put who wrote a
  row in the row if it matters; the app cannot learn the member from the
  host yet).
- **Home app:** the app pinned as the hub (Team admin > Settings) is also the
  members' home page while it is at team level or lower with a green
  published build. `host.hub.get()` answers there too: sections are the
  newest team pages, and a section's `token` is the page id.

## Team Hub apps (a designated app as the members' home)

A brain can designate one published app as its **home app**: member logins
get it full-screen on their home page (`GET /api/member/home`, member-logins.md
section 7) while it is at team level or lower with a green published build.
Until member logins Phase 6 the same app was the team-code **Team Hub** at
`/hub`, beside the `/team` workspace and the Forum; those are retired and
redirect to `/login`. Home apps get one extra namespace, `host.hub.get()`
(site name, member name, briefing sections, Library counts),
`host.hub.openChat()`, `host.hub.openBriefing(token)`, and the built-in member
home renders automatically if the app ever breaks.

Everything else about building one is this guide, plus the hub-specific
contract, project structure, and content-update patterns (including the
zero-publish "tiles from a Table" pattern) in
[team-hub-app-sdk.md](team-hub-app-sdk.md), read that before building a hub
app.
