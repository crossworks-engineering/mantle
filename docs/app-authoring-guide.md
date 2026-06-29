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
4. **`app_build(id)`** → `{ build_ok, errors[], warnings[], bytes }`. Each error
   carries file/line/column. Fix the offending file and rebuild until
   `build_ok`. A failed build never replaces the last good preview.
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
host.ui.resize(heightPx)             // tell the host how tall to make the iframe
host.ui.notifyError(message)         // surface an error to the host UI
host.ui.onAnnotate(fn)               // subscribe to inspector annotations
```

Everything is brokered by the parent over postMessage and executed server-side,
so the iframe never sees secrets or credentials.

## Binding to data — the important part

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
