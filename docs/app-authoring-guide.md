# Authoring Mantle mini-apps from an MCP client

How an external Claude (Claude Code / Claude Desktop, on your own subscription)
builds a Mantle `/apps` mini-app end to end through the Mantle MCP server — and
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
   - `app_source_set(id, entry, files)` — upload the **whole tree** at once
     (`entry` must be one of the keys in `files`); best when you wrote the app
     locally, or
   - `app_file_write(id, path, content)` — one file at a time;
     `app_file_delete(id, path)` to remove one (can't delete the entry).
3. **Grant data access** (see *Binding to data* below):
   - `app_tools_set(id, tool_slugs)` — the runtime allowlist of tool slugs the
     app may call. The host refuses any slug not declared here.
   - `app_db_schema_set(id, schema_sql)` — optional per-app SQLite DDL.
   - `app_db_seed(id, table, rows, replace?)` — optional one-time bulk load of
     reference data into a declared table (atomic; ≤2000 rows/call, batch
     bigger sets).
4. **`app_build(id)`** — a failed compile **fails the call**, with every error's
   file/line/column in the error text. Fix the offending file and rebuild until
   it succeeds (success returns `{ build_ok: true, warnings[], bytes }`). A
   failed build never replaces the last good preview.
5. **Review** at `/apps/<id>` (the preview renders the draft build).
6. **`app_publish(id)`** — promotes the draft + its green build to live. Refuses
   without a successful build.

`app_get(id, include_source?)` reads an app back; `app_list()` browses them;
`app_delete(id)` removes one (irreversible — confirm first).

Drafts are isolated: every edit lands in the draft; the published app is
untouched until `app_publish`.

## Allowed imports (the bundler allowlist)

Only these resolve — esbuild **rejects any other bare import**:

- `react` (hooks, etc.)
- `@/components/ui/*` — `button`, `card`, `input`, `label`, `badge`, `separator`
- `cn` from `@/lib/utils`
- `lucide-react` icons
- `host` from `@host` (the runtime bridge — below)
- relative files within the app (`./lib/fmt`, etc.)

No `axios`, no `date-fns`, no arbitrary npm. Bring helpers as local files.

## The entry contract

The entry file **must** `export default function App() { … }`. Default entry
path is `App.tsx`.

## Layout — you get a full viewport, you own it

An app now renders in a **real full-screen viewport** (in the `/apps` preview,
the editor, and a shared link alike) — not the old content-hugging box. **The
app decides its own size, layout, and scrolling.** So:

- A dashboard should fill the space: `h-full` (or `h-dvh`) from the root, its own
  internal scroll areas (`min-h-0` + `overflow-y-auto` on panes), sticky headers,
  sidebars — all fair game now.
- A small form or list doesn't have to fill it — render a centred column
  (`mx-auto max-w-md`) and let the rest be empty; that's fine.
- Viewport-height utilities (`h-dvh`, `min-h-screen`, `vh`/`vw`) are **real** here
  — use them. (The old guidance to avoid them applied to the previous
  auto-sizing frame and no longer holds.)
- `host.ui.resize()` is a legacy no-op — there's nothing to resize; the frame is
  the viewport.

## Styling: theme tokens only

Use theme classes so the app follows the user's live theme — **never hardcode
colours** (a hex value breaks on theme switch):

`bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`,
`bg-primary` + `text-primary-foreground`, `bg-muted` + `text-muted-foreground`,
`border`, and the chart ramp `chart-1`…`chart-5`. Compose with `cn(...)`.

## The `@host` runtime bridge

The app's only window onto the host. `import { host } from '@host'`:

```ts
await host.tools.call(slug, input)   // call a DECLARED tool; returns its result
await host.db.query(sql, params?)    // read from this app's own SQLite
await host.db.exec(sql, params?)     // write to this app's own SQLite
host.ui.resize(heightPx)             // legacy no-op — apps get a real full-screen viewport now (see Layout)
host.ui.notifyError(message)         // surface an error to the host UI
host.ui.onAnnotate(fn)               // subscribe to inspector annotations
```

Everything is brokered by the parent over postMessage and executed server-side,
so the iframe never sees secrets or credentials.

## Binding to data — the important part

**First: many apps need no data binding at all.** A calculator, converter, or
visualizer whose logic is pure code ships with zero tools and zero database.
The tiers, simplest first: (1) pure code — nothing to wire; (2) fixed reference
data — seed the per-app SQLite once with `app_db_seed` (below); (3) live
external/owner data — a declared tool via `host.tools.call`. Don't reach for
tier 3 when tier 1–2 suffices.

A running app **cannot read your notes / tables / entities directly**. It can
only reach owner data via:

1. **`host.tools.call(slug, input)`** — and only for slugs you put in the app's
   allowlist with `app_tools_set`. These run server-side under your owner scope.
2. **Per-app SQLite** (`host.db`) — app-local state, **not** the brain.

So to show your data in an app, you give it a tool that returns that data:

- **Mint a purpose-built tool** with the Toolsmith MCP tools (also available over
  MCP): `recipe_tool_create` composes existing tools/builtins (e.g. `note_list`,
  `table_rows_list`, `search`) into one tool that returns exactly the shape the
  app needs; `api_tool_create` wraps an external HTTP API.
- Or **declare an existing owned tool** you already have, if it returns what you
  need.

Then `app_tools_set(id, ['that_slug'])` and call it from the app.

**Recommended flow (this is the synergy):** first *explore the data yourself*
with your own MCP read tools (`search`, `table_list`, `note_list`, …) to learn
its real shape; then mint a recipe tool that returns precisely that; then build
the app against it. You're binding the app to data you've actually inspected, so
the queries are correct, not guessed.

## Per-app SQLite

For app-local state (caches, user-entered rows, preferences). Declare DDL via
`app_db_schema_set(id, "CREATE TABLE IF NOT EXISTS …")`; the host provisions the
DB on first use. At runtime use `host.db.query/exec`. `ATTACH`, `DETACH`,
`PRAGMA`, and `VACUUM INTO` are blocked. Treat schema as **append-only** — there
are no destructive migrations; add columns/tables, use views for renames.

**Seeding reference data** — when the app needs pre-loaded lookup data (a
reference table, a rate matrix, rows imported from a spreadsheet), load it at
authoring time with `app_db_seed(id, table, rows, replace?)`: an atomic bulk
INSERT validated against the live table columns (values: string / number /
boolean / null; ≤2000 rows per call — batch bigger sets, `replace: true` on
the first batch only). Read the source data with your own read tools
(`file_read`, `table_rows_list`, …), transform, seed, then verify with
`app_db_query`. This is a one-time authoring step, **not** an integration —
don't mint a tool or build an import UI for it, and don't ship an app that
asks its user to paste in its own reference data.

Each app gets **one durable SQLite file**, isolated per app — there's no path
input, so an app can only ever reach its own database. Operationally it's a
first-class store: it runs in **WAL mode** (concurrent readers don't block a
writer — matters when an app is shared with several people, or the assistant
reads it while the app writes), and it's **included in the backup**
(`scripts/db-dump.sh` snapshots every app DB alongside the Postgres dump with a
consistent `VACUUM INTO`). App-authored data is real data, and it's protected
like the rest of the brain.

## Reading app data from the brain (the assistant can query your apps)

The user's **assistant can read any of their apps' databases** — the responder
holds two read-only tools, `app_db_list` (which apps have a DB + their tables)
and `app_db_query` (a `SELECT` against one app by id). So data an app stores is
answerable in normal conversation: *"how many open items in my tracker app?"*,
*"what's in the inventory table?"* — no extra wiring by you, the author.

Two things follow for how you design an app's schema:

- **Give tables and columns clear, self-describing names.** The assistant reads
  the live schema (`sqlite_master`) to know what to query, so `tasks(title,
  status, due_at)` is far more useful to it than `t(a, b, c)`.
- **It is strictly read-only** — the database is opened read-only, so no query
  the assistant runs can ever mutate your app's data. (Writes still come only
  from the app itself via `host.db.exec`.)

This is on by default for all the user's apps — the brain/team is the trust
boundary, so there's no per-app "make readable" switch.

## Worked example — "My Notes" app

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
via the **Share** control on the app header. There are two admission modes, and
they grant very different capability — pick with the "Team members only" toggle:

### Public (anyone with the link)

Anonymous visitors. A public app can use **only its own SQLite database, and
only for reads** (`host.db.query`). It gets **no brain tools at all** — every
`host.tools.call` is refused on a public link, and `host.db.exec` (writes) is
blocked. This is deliberate and enforced server-side: the whole brain is private
data, and there's no way to expose a *slice* of it safely to the anonymous
public, so the answer is "none." A public app is a self-contained, read-only
view over data it already holds (or data baked into its bundle).

> This changed: earlier, a public link could invoke an app's declared tools.
> It can't anymore — declaring a data tool does nothing for a public share.
> If your app needs brain data for outside viewers, it needs **team** mode.

### Team (your team members, identified)

Team mode requires the visitor to enter a **team token**. You mint one per
person by marking a Contact a *team member* (`/contacts` → the "Team member"
toggle → the token is shown once; regenerate or remove to revoke). Entering a
valid token identifies the visitor as that Contact, and from then on:

- the app may use its **declared tools** (they run under **your** scope, secrets
  resolving server-side — the iframe never sees a key) and **write** to its
  SQLite;
- every action — token entry, each tool call, each DB write — is **audited to
  that team member**, visible on the app's **Activity** tab.

Removing or disabling a team member kills their access immediately (membership
is re-checked on every request, not just at token entry).

**One safety limit even in team mode:** a shared app can drive **built-in tools
only** — `http`/`shell`/`recipe` tools are refused through a share, so an app
can never hand a team member arbitrary server-side HTTP or command execution
under your account. Declare built-in data tools; keep custom HTTP/shell tools
out of an app you intend to share.

**Rule of thumb:** public = "a read-only view of this app's own data, safe for
anyone"; team = "identified, audited teammates who may use my tools and write
data." Treat any share link as a secret; revoke by turning the share off.

## Team Hub apps (a designated app as the /hub surface)

A brain can designate one published app as its **Team Hub**: team members
visiting `/hub` get that app full-screen, while the platform keeps the token
gate, the live Team Chat, and the briefing reader core. (`/team` itself is the
read-only member **workspace** — see [`team-chat.md`](team-chat.md) §2; the
same team cookie opens both surfaces.) Hub apps get one extra
namespace — `host.hub.get()` (site name, member name, briefing sections, live
stats), `host.hub.openChat()`, `host.hub.openBriefing(token)` — and the
built-in hub renders automatically if the app ever breaks.

Everything else about building one is this guide, plus the hub-specific
contract, project structure, and content-update patterns (including the
zero-publish "tiles from a Table" pattern) in
[team-hub-app-sdk.md](team-hub-app-sdk.md) — read that before building a hub
app.
