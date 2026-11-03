# Authoring Mantle mini-apps from an MCP client

How an external Claude (Claude Code / Claude Desktop, on your own subscription)
builds a Mantle `/apps` mini-app end to end through the Mantle MCP server, and
binds it to your real Mantle data.

> This file is the canonical reference. An MCP client reads it with the
> `app_authoring_guide` tool, whole or one section (`section: "who is
running"`); the server instructions and the `app_create`, `app_source_set`
> and `app_file_write` descriptions point there. Inside the brain, Appsmith
> carries the same rules as the `app_authoring` skill
> (`server/web/lib/system-manifest/prompts.ts`); keep the two in sync when you
> change the app platform.

## What a mini-app is

A mini-app is **real TSX**, bundled server-side by esbuild and rendered in a
**sandboxed, opaque-origin iframe** (no credentials, no same-origin). Its source
is a small virtual file tree stored on the app row (`{ entry, files }`, max **50
files / 256 KB each**). It reads and writes your data **only** through tools you
explicitly grant it and an optional per-app SQLite database.

## The build loop (MCP tools)

0. **`app_authoring_guide(section?)`**: read this guide first.
1. **`app_create(name, description?, icon?, tags?)`** → returns the app `id`.
2. **Author the source.** Either:
   - `app_source_set(id, entry, files)`, upload the **whole tree** at once
     (`entry` must be one of the keys in `files`); best when you wrote the app
     locally, or
   - `app_file_write(id, path, content)`, one file at a time;
     `app_file_delete(id, path)` to remove one (can't delete the entry).

   To **change** an app that exists, edit it in place with the code tools
   (_Editing source in place_ below): read one file or a range of lines,
   search the tree, replace exact text, and get a diff back, instead of
   reading every file and writing whole files back.

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
6. **`app_publish(id, summary)`**: promotes the draft + its green build to
   live. Refuses without a successful build. Pass `summary`: a few plain
   sentences on what the app is, who it is for, how to use it and the tables
   it keeps (600 characters at most). Search and the assistants find the app
   by it, and it stays until you pass a new one. Without one, a model writes
   it from the code when the app is indexed.

`app_get(id, include_source?)` reads an app back (with its `rev`); `app_list()` browses them;
`app_delete(id)` removes one (irreversible, confirm first).

Drafts are isolated: every edit lands in the draft; the published app is
untouched until `app_publish`.

## Editing source in place (the code tools)

Six tools view and edit an app's source without moving whole files. Each
takes a `target`: `app:<id>` (the app's id from `app_list`), the app's
**draft** tree (else its published tree). They copy the shape of the
Anthropic text editor tool and the MCP filesystem server's `edit_file`.

| Tool                                                             | What it does                                                                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_view(target, path?, start?, end?)`                         | No `path`: the file tree with sizes and line counts, the entry and the tree's `rev`. With a `path`: numbered lines, only `start`..`end` when given.                                                       |
| `code_search(target, pattern, regex?, glob?, ignore_case?)`      | `file:line: text` hits, capped; the result says how many there were in all. A regex is stopped if it runs too long.                                                                                       |
| `code_edit(target, path, edits[], dry_run?, base_rev?, build?)`  | Each edit is `{ old, new, replace_all? }`. `old` must match exactly once (else the call fails, says how many hits and on which lines). All edits apply or none. Returns a unified diff and the new `rev`. |
| `code_insert(target, path, after_line, text, base_rev?, build?)` | Adds lines after a line number (0 is the top).                                                                                                                                                            |
| `code_write(target, path, content, base_rev?, build?)`           | Creates or replaces one whole file (`app_file_write` with the revision check).                                                                                                                            |
| `code_undo(target, edit_id?, path?, base_rev?)`                  | Takes back one write (its `edit_id`, or the newest write of `path`) while its files are as it left them; returns its own `edit_id`.                                                                       |

- **The revision (`rev`).** Every read and write returns the tree's `rev`.
  Pass it back as `base_rev`: when another agent, the editor or a restore
  changed the draft since, the write fails and names the current rev
  (read again, then redo the change). `app_get` returns the `rev` too, and
  `app_source_set` takes `base_rev`, so a push from a local copy over a
  newer draft fails the same way.
- **`build: true`** runs `app_build` in the same call and returns its errors
  (file, line, column). The edit is saved either way; a failed build never
  replaces the last good preview.
- **Undo.** Every write through these tools, `app_file_write`,
  `app_file_delete` and `app_source_set` records what it changed (a
  `pre_code_edit` entry on the app's history line: the files it changed as
  they were, code only) and returns its `edit_id`. `code_undo` with that
  `edit_id` puts those files back (a file the write created is removed),
  and only while each is still exactly as that write left it; else it fails
  and changes nothing, so later work (another write, the editor, an import,
  a restore) is never replaced: change the file with `code_edit` or
  `code_write` instead. With only a `path`, it takes back the newest write
  of that file. An undo is a write too, with its own `edit_id`: undo it to
  redo. Undoing to code taken while the app ran at team rules puts the app
  back at team rules, as a snapshot restore does. The newest 20 entries are
  kept per app (fewer when they pass `APP_CODE_EDIT_MAX_MB`, default 64),
  and the History tab leaves them out; for a whole earlier version use
  `app_snapshot_restore`.
- **Line ends.** A file whose every line ends in CRLF shows with LF in
  `code_view`; edits and inserts match on that text and keep the CRLF. A
  file with mixed line ends shows and edits as stored.
- **Access** is the app tools': `code_view` and `code_search` read what
  `app_get` reads; the four writes ask what `app_file_write` asks.

A typical fix: `code_search` for the text, `code_view` the lines around the
hit, `code_edit` with `base_rev` and `build: true`, then preview and publish.

## Languages and kits

A mini app is TSX (React) that runs in the browser; the entry file exports
`default function App()`. What it may import is the bundler's allowlist
(below): `code_view` with a target and no path returns it live, as `kit`
(the language, the entry rule, each allowed import with its guide, and the
libraries refused), so it is right for this brain's version even as
libraries are added. Read a library's guide with
`canvas_library({ name, for: 'app' })` before using it. An import that is
not allowed fails `app_build` (or `build: true` on a code tool), and the
error names the allowed list.

## Allowed imports (the bundler allowlist)

Only these resolve, esbuild **rejects any other bare import**:

- `react` (hooks, etc.)
- `@/components/ui/*`, `button`, `card`, `input`, `label`, `badge`, `separator`
- `cn` from `@/lib/utils`
- `lucide-react` icons
- `host` from `@host` (the runtime bridge, below)
- relative files within the app (`./lib/fmt`, etc.)
- the vendored libraries, by these exact names (see Libraries below; call
  `canvas_library(name, for: 'app')` first): `echarts`, `d3`, `three`,
  `three/addons/controls/OrbitControls.js`, `konva`, `katex`, `motion/react`,
  `@mantle/diagram-templates/browser`, `mathjs`, `date-fns`, `zod`,
  `@tanstack/react-table`, `@tanstack/react-virtual`, `@dnd-kit/core`,
  `@dnd-kit/sortable`, `fuse.js`, `papaparse`, `pdf-lib`, `qrcode`,
  `markdown-it`, `dompurify`

No `axios`, no `lodash`, no arbitrary npm. Bring helpers as local files.
Type-only imports (`import type { ReactNode } from 'react'`, `import { type X }`,
`export type { X } from`) are erased at compile time, so neither check counts them.

## Libraries: charts, 3D, grids, maths, dates, forms, files, diagrams

A pinned library set, served by the brain to the app frame (never from a
CDN, never bundled into the app: each library is its own file, so an app
pays for a library only when it imports it, and every app shares one
cached copy). The plain libraries are the files a Present canvas loads; the
ones that need React run on the app's one shared React.
**Call `canvas_library(name, for: 'app')` before you use one.** It returns the
import as an app writes it, the library's API for this exact version, the
React pattern, and a complete `App.tsx` that a browser test renders.

| Import                                                                    | Use it for                                  |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| `import * as echarts from 'echarts'`                                      | business charts and dashboards              |
| `import * as d3 from 'd3'`                                                | custom charts, scales, shapes, force graphs |
| `import * as THREE from 'three'`                                          | 3D scenes                                   |
| `import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`  | orbit, zoom and pan for a 3D scene          |
| `import Konva from 'konva'`                                               | 2D shapes people drag and click             |
| `import katex from 'katex'`                                               | typeset formulas                            |
| `import { motion, AnimatePresence } from 'motion/react'`                  | animation                                   |
| `import { render, domMeasurer } from '@mantle/diagram-templates/browser'` | flow and P&ID diagrams drawn from data      |

### Which library for which job

| The job                                                                | Import                                                                                                           | Guide (`canvas_library`) |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Units and engineering maths, formulas a person types for their own use | `import { evaluate, unit, format } from 'mathjs'`                                                                | `mathjs`                 |
| Dates: format, add business days, ranges                               | `import { format, addBusinessDays, parseISO } from 'date-fns'`                                                   | `date-fns`               |
| Form checks, the shape of rows                                         | `import { z } from 'zod'`                                                                                        | `zod`                    |
| A big grid: sort, filter                                               | `import { useTable, tableFeatures, createColumnHelper } from '@tanstack/react-table'`                            | `tanstack-table`         |
| A long list (thousands of rows)                                        | `import { useVirtualizer } from '@tanstack/react-virtual'`                                                       | `tanstack-virtual`       |
| Drag and drop, reorder a list, a board                                 | `import { DndContext } from '@dnd-kit/core'`, `import { SortableContext, useSortable } from '@dnd-kit/sortable'` | `dnd-kit`                |
| Fuzzy search (typos, partial words)                                    | `import Fuse from 'fuse.js'`                                                                                     | `fuse`                   |
| CSV in and out                                                         | `import Papa from 'papaparse'`                                                                                   | `papaparse`              |
| Make or fill a PDF                                                     | `import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'`                                                      | `pdf-lib`                |
| QR codes for labels and tags                                           | `import QRCode from 'qrcode'`                                                                                    | `qrcode`                 |
| Show markdown                                                          | `import MarkdownIt from 'markdown-it'` and `import DOMPurify from 'dompurify'`                                   | `markdown`               |

**Markdown is always sanitized.** `markdown-it` output reaches the DOM only
through DOMPurify: `DOMPurify.sanitize(md.render(text))`, then
`dangerouslySetInnerHTML`. Text from `host.db` was typed by someone; never
put markdown-it HTML in the page without it.

**math.js is not a sandbox for other people's formulas.** A person's own
formula is fine; formula text another person saved can hang the tab or
quietly change math.js's numbers for the session. Save the inputs and keep
the formula in the app's code; pass saved values as numbers in the scope
(`evaluate(f, { p: Number(saved.p) })`), never spliced into expression text.

TanStack Table is **v9** (`useTable`, `tableFeatures`): the v8 API
(`useReactTable`, `getCoreRowModel`) does not exist in it. Its guide has the
v9 pattern.

The large ones (mathjs about 750 KB, zod about 450 KB, pdf-lib about 440 KB)
load only in an app that imports them; an app that imports none of the
libraries loads the same base runtime as before.

The React pattern, the same for each library that owns a DOM node: a
container with a real height in a `useRef`; create the chart, scene or stage
in a `useEffect`; return a cleanup that disposes it (`chart.dispose()`,
`renderer.dispose()`, `stage.destroy()`); a `ResizeObserver` for size; theme
tokens (`--chart-1`, `--foreground`, which are `oklch()`) converted to rgb for
a library that paints a canvas, read again when the host switches theme.

Exact names only: `echarts/core`, `three/examples/jsm/...` and `d3-scale` are
refused. Not available in an app: `reveal.js` (a deck is a Present canvas),
`alpinejs` (it competes with React for the DOM and needs `unsafe-eval`),
plain `motion` (use `motion/react`), `date-fns/locale` and every other
subpath, `@dnd-kit/utilities`. The frame has no `unsafe-eval`, so
`d3.csvParse` (it compiles its row reader with `new Function`) fails here: use
`d3.csvParseRows`, `papaparse`, or rows from `host.db`. Zod runs with
`jitless` on for the same reason (set by the brain; nothing to do).

**Not possible in the frame** (no network, by its CSP, and no downloads, by
its sandbox): web map tiles (Leaflet, MapLibre, Google Maps need a tile
server; draw a site plan as SVG, or with `d3` geo projections from data you
hold), live fetches from any API (data comes from `host.db` or a declared
tool), and a file download (`papaparse` and `pdf-lib` make the bytes; keep
them in `host.db`, export rows to a Table, or make the report with
`pdf_render`, below). `papaparse` refuses `download` and `worker` with an
error that says so.

A diagram template (`flow`, `pid`) takes data and returns an SVG string;
with `{ theme: 'tokens' }` it draws in the app's theme, light and dark, and
follows a live switch; its data contract is `diagram_guide` with `type` `flow` or `pid`, and
`diagram_render` draws data to look at it. Showing a saved Present canvas
inside an app is not supported (the app frame allows no nested frame).

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

**The host shows your name, icon and description.** In the workspace the
app sits under the host's one header row (the item header every page, note
and table has): it shows the app's icon and name, and its description sits
behind ⓘ. So don't draw them again: no title or `<h1>` with the app's name, no
hero block, no intro line that repeats the description. Start with the app's
own content (its toolbar, inputs, data). Headings for sections inside the app
are fine. A shared link and a home app show the app on its own, without
the header; if the app must name itself there, keep it to one small line, never
a hero.

## Styling: theme tokens only

Use theme classes so the app follows the user's live theme, **never hardcode
colours** (a hex value breaks on theme switch):

`bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`,
`bg-primary` + `text-primary-foreground`, `bg-muted` + `text-muted-foreground`,
`border`, and the chart ramp `chart-1`…`chart-5`. Compose with `cn(...)`.

## The `@host` runtime bridge

The app's only window onto the host. `import { host } from '@host'`:

```ts
await host.me()                      // who runs the app: { id, name, kind } (see below)
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

## Call budget: batch, save once, audit

Every `host.db.query`, `host.db.exec` and `host.tools.call` is one request
to the brain, and each login has a budget a minute, an Admin user's too:

| Bridge call                                 | Budget a minute, per login |
| ------------------------------------------- | -------------------------- |
| `host.db.query` and `host.db.exec` together | 600                        |
| `host.tools.call`                           | 120                        |
| opening the app (its frame ticket)          | 30                         |

Over it, the call fails with `Too many requests: this app made more than
...`, which names the budget, says how to stay under it and how many
seconds to wait. A busy screen built one call per row reaches it in
seconds, so build for the budget from the start:

- **One query for many rows.** Read with `WHERE id IN (?, ?, ...)` or a
  `JOIN`, never one query per row in a loop. Read a screen's data once and
  keep it in state; do not ask again for what you already have.
- **One write for many rows.** `INSERT ... VALUES (...), (...)` with
  `ON CONFLICT ... DO UPDATE` (or `INSERT OR REPLACE`), or an `UPDATE ...
SET col = CASE id WHEN ? THEN ? ... END WHERE id IN (...)`. Chunk big
  sets (SQLite allows 999 parameters a statement). Never one `exec` per row.
- **Save text when typing stops.** Update the screen at once, but save a
  text field about 800 ms after the last keystroke, on blur, and when the
  page is hidden; write only the columns that changed, for that one row.
- **Tools take many rows too.** Pass an IN list or a `rows` array to a tool
  that takes one (a SQL tool, `table_rows_upsert`) instead of a call per
  row. Where a tool takes one item only, pace the calls (below).
- **No tight polling.** Refresh no more often than every 15 to 30 s, and
  only while the app is visible (`document.visibilityState`).
- **One paced wrapper.** Route every bridge call through one small helper
  that keeps about 3 to 4 calls in flight and, on a 429 (`code`
  `rate_limited`, or `Too many requests` in the message), waits the
  `retryAfter` seconds (or 2 s, doubling) and tries again up to 3 times. A
  refused call never ran, so the retry is safe for writes. Keep real errors
  as they are.

**Audit before you publish.** Read your own source for every bridge call
and ask how many requests one user action makes: opening the app, opening
an item, one keystroke, one save, a bulk action, a refresh. Anything that
grows with the number of rows is a loop to batch. Write the count down in
the app's description or a code comment for the busiest action, keep it
well under the budget, and check `app_errors` after publishing.

## Who is running the app

An app can learn who runs it, and record it so that it cannot be faked.

**For display: `host.me()`.**

```ts
const me = await host.me();
// { id: 'u_3qK…', name: 'Pat', kind: 'member' }
```

| Field  | What it is                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`   | Stable for this person **in this app only**. `null` on an open link.                                                         |
| `name` | The login's display name, or the contact's name. `null` when none is set, and on an open link.                               |
| `kind` | `'admin'` (the owner or an admin login), `'member'`, `'contact'` (a Contact share), or `'public'` (an open /s link: nobody). |

A row an app wrote before workspaces W8a may hold `'client'`: the client
logins are gone ([client-logins.md](./client-logins.md)), so no run gets
that kind now.

There is **no email**: an app is code the admin may not have written.
`host.me()` works on every surface (the editor preview, the member
shell, a Contact share, an open link) with no round trip: the
server bakes the answer into the app's frame. Use it to greet, to show
"you", or to filter a view. Do not build permission logic on it: the app
can change its own copy.

**Why a per-app id.** The id is a pseudonym (an HMAC of the login or
contact id, keyed per app), so the same person has a different id in every
app and an app cannot follow a person to another app. It does not change
when a login's role changes. An app copied by export and import gets new
ids.

**For data: the server-filled parameters.** To record who did something,
write these names **in the SQL itself** of a `host.db.exec` or
`host.db.query`:

| Parameter       | Filled with      |
| --------------- | ---------------- |
| `:host_me_id`   | `host.me().id`   |
| `:host_me_name` | `host.me().name` |
| `:host_me_kind` | `host.me().kind` |

The **broker fills them on the server** from the signed-in session. The
browser cannot set them: a request that sends a value under any name
starting with `host_me_` (any case, with or without `:`, `@` or `$`) is
refused with 400, and so is an unknown reserved name such as
`:host_me_email`. Mix them freely with your own `?` values (or your own
named values: pass one object first, `[{ due: d }, x]`). SQL that uses none
of them runs exactly as before. On an open link they are `NULL`, `NULL`,
`'public'`, and an open link cannot write anyway. The assistant's
`app_db_query` names no person, so SQL with these names is refused there.

Example: a review log that shows who approved what.

```sql
-- app_db_schema_set
CREATE TABLE IF NOT EXISTS review_log (
  id          INTEGER PRIMARY KEY,
  item        TEXT NOT NULL,
  verdict     TEXT NOT NULL,          -- 'approved' | 'rejected'
  by_id       TEXT,                   -- :host_me_id (NULL from an open link)
  by_name     TEXT,                   -- :host_me_name, as it was at the time
  by_kind     TEXT NOT NULL,          -- :host_me_kind
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

```ts
// Record: the server fills who; the app sends only what.
await host.db.exec(
  'INSERT INTO review_log (item, verdict, by_id, by_name, by_kind) ' +
    'VALUES (?, ?, :host_me_id, :host_me_name, :host_me_kind)',
  [item, 'approved'],
);

// "My reviews": filter on the server-filled id, not on a value you send.
const mine = await host.db.query(
  'SELECT item, verdict, at FROM review_log WHERE by_id = :host_me_id ORDER BY at DESC',
);

// Show everyone's log, and mark your own rows.
const me = await host.me();
const all = await host.db.query('SELECT * FROM review_log ORDER BY at DESC LIMIT 200');
const rows = all.map((r) => ({ ...r, mine: r.by_id === me.id }));
```

Store the name next to the id: names can change, and the row should say
who it was at the time. The host's own access log (the app's Activity tab)
still records every open, read and write per login, whatever the app does.

**A filter on `:host_me_id` is a view, not privacy.** It decides what the
app shows, never what a runner may read: everyone who runs the app may send
any `SELECT` to its database (`SELECT * FROM review_log` from the browser's
console works as well as the app's own query). That includes an anonymous
visitor on an **open link** (the id is `NULL` for them, but they read every
row). So an app that has an open link serves every row of its database to
anyone who holds the link, rows a contact wrote through their own Contact
share included. Keep what a contact or member writes out of an app you also
share by open link.

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
  `table_rows_list`, `table_query`, `search_nodes`, …). This is the kind
  that works for **members**: a member's run of an app gets read-only
  built-in tools, plus a connector's tools when the connector is attached
  to every workspace that holds the app (a tool without the admin's
  read-only mark writes), and an http tool only when an admin switched
  "External access" on for it (docs/member-logins.md). An open share link
  gets no tools at all.
- **Apps only the Admin workspace holds** (and that an Admin user built)
  may also use a purpose-built tool from the Toolsmith MCP tools:
  `recipe_tool_create` composes existing tools into one tool that returns
  exactly the shape the app needs; `api_tool_create` wraps an external HTTP
  API. Team rules and share links refuse recipe and shell tools always
  (they run under the brain), and an http tool unless an admin switched
  "External access" on for it, so never give a recipe to an app you share
  with another workspace or by link.

Then `app_tools_set(id, ['that_slug'])` and call it from the app. For an app
that runs at team rules (below) the result carries `warnings`: one per
declared tool those rules refuse (see "Team apps" below).

**Which rules an app's tools run under.** Everyone who runs an app shares
its database, and whatever a tool returns can end up there. So an app reads
only what every workspace that holds it reads (`appToolLevel`). An Admin
user's run of an app that only the Admin workspace holds keeps that user's
own rules and runs any declared tool. Every other run uses the team rules:
any run of an app another workspace holds (an Admin user's run included),
and every member's run. The author ceiling (see "Members build apps") puts
an app a user outside the Admin workspace built at team rules for every
runner too. A run at team rules reads through the app: what its holding
workspaces read, met with the runner's own workspaces, never the runner's
other workspaces. There are no client rules and no `client_shared_*`
tools: the client logins are gone (workspaces W8a). Any user may author apps in a
workspace they moderate (see "Members build apps").

**Recommended flow (this is the synergy):** first _explore the data yourself_
with your own MCP read tools (`search`, `table_list`, `note_list`, …) to learn
its real shape; then pick the built-in tool that returns it (or, for an
admin-only app, mint a recipe tool that returns precisely that); then build
the app against it. You're binding the app to data you've actually inspected, so
the queries are correct, not guessed.

## Pictures: a stored image, a drawing

An app has no network of its own, so a picture reaches it through a tool. Two
declared tools answer one when the call says `bytes: true`, as base64 in the
output. Only an app's call gets that; at most 16 MB a call. Past 4 reads or 2
drawings at once the call answers an error that says to call again, so read
them a few at a time.

```tsx
// A stored image (declare file_read):
const f = await host.tools.call('file_read', { file_id: imageId, bytes: true });
const src = `data:${f.mime_type};base64,${f.content_base64}`;

// A DWG or DXF, framed on its sheet (declare dwg_render):
const d = await host.tools.call('dwg_render', { file_id: dwgId, edge: 4000, bytes: true });
// d.window is what it shows, d.sheet the sheet, d.off_sheet what sits off it.
// Pass a window to zoom: { file_id: dwgId, window: d.off_sheet[0].window, bytes: true }
```

`file_read` without `bytes` still gives the text the extractor read, and
`content: null` for a picture. `dwg_render` draws on each call, which takes
seconds, one drawing at a time across the brain: draw when a person opens a
drawing, and keep the answer in state. Do not store the base64 in a Table or
a text file. A window with nothing in it answers a `note` and no picture.

## Reports: a PDF from the app

Every app can make a PDF or a picture through the documents engine. The
brain's **Documents** service is on by default (Settings > Services); while
an admin has it off, the four tools answer that it is off. Declare
`pdf_render` (and `screenshot_render`, `office_to_pdf` or `pdf_tools` if the
app needs them) with `app_tools_set`, then call it with the HTML the app
renders:

```tsx
async function exportReport(rows: Row[]) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>body{font-family:sans-serif} td{padding:4px 8px}</style></head>
    <body><h1>Monthly report</h1><table>${rows
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${r.total}</td></tr>`)
      .join('')}</table></body></html>`;
  const r = await host.tools.call('pdf_render', {
    html,
    footer_html:
      '<html><body><div style="font-size:9px;width:100%;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div></body></html>',
    options: { paperWidth: 8.27, paperHeight: 11.69, marginBottom: 0.6, printBackground: true },
    filename: 'monthly-report',
  });
  // r = { route, file_id, filename, path, size_bytes, mime_type, landedIn }
  return r;
}
```

`options` are the engine's own fields (paper size and margins in inches or
with a unit, `landscape`, `printBackground`, `pdfa`, `metadata`; the
Gotenberg docs are the reference). The HTML can fetch nothing from the
network: the engine reaches only the brain's own print pages, so inline the
CSS and put images in `asset_file_ids`.

**Get the PDF back in the app.** Pass `bytes: true` and nothing is saved:
the answer is `{ route, filename, mime_type, size_bytes, content_base64 }`,
which the app shows or offers as a download. The caps are those of
`file_read`'s `bytes` (16 MB a call, a few at a time; past them the call
says so). A saved file is read back the same way, with
`file_read({ file_id, bytes: true })`.

```tsx
const r = await host.tools.call('pdf_render', { html, bytes: true });
const blob = await (await fetch(`data:${r.mime_type};base64,${r.content_base64}`)).blob();
const url = URL.createObjectURL(blob); // an <a href={url} download={r.filename}>, or an <iframe>
```

**Where the PDF lands.** Without `bytes`, the file is saved, and where
depends on who holds the app:

- An app the Admin workspace alone holds (an admin built it): where an
  admin's export lands, Auto-filed / Exports. `node_id` instead of `html`
  prints a page or a drawing of the brain.
- A **team app** (another workspace holds it, or a member built it): at the
  top of Files, homed in **the workspace that holds the app**, never in the
  runner's private workspace and never in Admin (an app only you hold, in
  your private workspace, saves there). It is found by its name and
  folder, and no model reads it. Only a user who moderates that
  workspace saves there (the rule for every new item); anyone else gets an
  error that says to pass `bytes: true`. So a team app that every user runs
  passes `bytes: true`, or saves only for its moderators. A team app reads
  its inputs (`file_ids`, `asset_file_ids`) in the app's own scope, and
  prints no page or drawing of the brain (`node_id` is refused: print the
  HTML the app builds). An app held by two workspaces beyond Admin saves
  nowhere (`bytes: true` still works).
- A shared link (an open or a coded share) runs no built-in tool, these
  included.

## Per-app SQLite

For app-local state (caches, user-entered rows, preferences). Declare DDL via
`app_db_schema_set(id, "CREATE TABLE IF NOT EXISTS …")`; the host provisions the
DB on first use. At runtime use `host.db.query/exec`. `ATTACH`, `DETACH`,
`VACUUM` and every `PRAGMA` except `table_info` / `table_xinfo` are blocked.
Each statement may run 5 seconds at most and return 50,000 rows and 8 MB at
most (add a LIMIT, select fewer columns or aggregate), and no single string or
blob may pass 16 MiB. The whole database file may hold 256 MB
(`APP_SQL_MAX_DB_MB`): a write past it fails with "database or disk is full"
and rolls back. Each login (an admin or a member) and each share link runs
one statement at a time, and the next waits its turn (a burst of more than 16
at once answers 429 busy), so prefer one query that joins over many small
ones. The declared schema runs under the same rules as one transaction (30
seconds at most): a script that fails anywhere applies nothing. Treat schema
as **append-only**: there are no destructive migrations; add columns/tables,
use views for renames.

**The whole script runs again on every new version**, over the tables the
app already has. So write it to be re-runnable: `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`. `app_db_schema_set` (and import, and
`apps-push`) first tries the script on a copy of the app's live database; a
script that fails there is refused with the reason and nothing is declared,
so a bad schema can no longer stop a running app. Each version is applied
once, across processes, and stamped into the file, so a crash in the middle
cannot leave the app stuck on "already exists".

**A lost database file is an error, never an empty app.** When an app has
stored something (a schema applied or a write recorded) and its file is gone
from the server, every read and write refuses with a clear error (503 to the
app, "missing on the server") and the server log names the path. The file is
not recreated empty: it has to come back from a backup.

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

## Timers: collect data on a clock

An app runs only while someone has it open. A **timer** calls one of the
app's declared tools on a clock with nobody there and no model: a status
poll every 5 minutes, a price every hour, a feed every day. Each run lands
as a row in the app's own database, so the app draws charts and history
from it the next time someone opens it.

```
app_timer_set({ app_id, name: 'fleet', tool: 'peer_status', every_minutes: 5 })
app_timer_list({ app_id })           // each timer: next run, last run, last error
app_timer_run({ app_id, name })      // a test: it runs within a minute (not sooner than its floor after the last run)
app_timer_delete({ app_id, name })
```

- **The tool**: one the app declares (`app_tools_set` first) that reads and
  spends nothing: a built-in read (`calculate`, `box_status`, `peer_status`,
  the list and get tools), or an HTTP tool an admin marked as only reading
  (External access). Never a write, a send, a delete, a sandbox or shell
  tool, a connector's or a recipe tool, a tool that runs a model, or one
  that needs the owner's confirmation. A risky tool (every `peer_*` tool)
  and an HTTP tool that sends a vault secret need an Admin user to set the
  timer. Checked when you set it and again before every run.
- **The arguments**: one JSON object (`args`, at most 8 KB), the same on
  every run, checked against the tool's input schema when you set it (its
  required arguments, their types, no argument it does not take).
- **Who it runs as**: you, the login that set it, with your rights now and
  read only: every run goes through the same plan and checks as a
  `host.tools.call` of yours in this app. Someone else who sets it again
  makes it theirs. If your login is removed, switched off, or no longer
  manages the app, its runs fail.
- **Who may set one**: a login that manages the app (a Moderator of its
  workspace). At most 5 timers per app and 20 per login; 100 per box, of
  which 20 only Admin users may set.
- **How often**: every 1 to 1440 minutes (default 5), at least every 5 for
  a login that is no Admin user and every 15 for an HTTP tool. The first
  run comes within a minute.
- **Failures**: a run that fails is recorded with a short reason. After 5
  failures in a row a timer runs at most every 30 minutes, until one
  succeeds or you change its tool or args. A new clock, a switch on or
  `app_timer_run` never runs it sooner than its floor (or that back-off)
  after its last run. A run has 60 seconds; an HTTP tool's own timeout is cut to that.

**Where the runs land**: the table `_timer_runs` in the app's own database,
made by the first run:

| column     | what                                                     |
| ---------- | -------------------------------------------------------- |
| `id`       | integer, ascending                                       |
| `timer_id` | the timer's id (`app_timer_list` gives it)               |
| `ran_at`   | when the run started, ISO text in UTC                    |
| `ok`       | 1 or 0                                                   |
| `ms`       | how long it took                                         |
| `result`   | the tool's output as JSON text (null when it failed)     |
| `error`    | a short fixed reason when it failed, else null           |
| `level`    | the rules it ran at: `admin` or `team` (null if refused) |

```ts
const rows = await host.db.query(
  `SELECT ran_at, result FROM _timer_runs WHERE ok = 1 AND ran_at > ? ORDER BY id`,
  [new Date(Date.now() - 86_400_000).toISOString()],
);
const points = rows.map((r) => ({ at: r.ran_at, ...JSON.parse(r.result) }));
```

Rows older than `keep_days` (default 90, at most 400) go on each run, and
so do the rows of a timer you deleted. Rows read at admin rules
(`level = 'admin'`) never stay where only team rules apply: when the app
comes to be held by a workspace other than Admin (or runs at team rules
for any other reason), the next run of any of its timers first removes
every row of the app kept at admin rules, whether or not that run's own
call works (until that run, they are there). Switching a timer off or
deleting it removes its rows kept at admin rules at once. A result over 256 KB is recorded as failed (`result too large`),
and when the database is full (256 MB) the run is recorded on the timer as
failed and nothing is written.

`_timer_runs` (and every name it begins) is **read only for the app**:
`host.db.query` and the app data tools read it; no app statement may
insert into it, change, delete, drop, rename or index it, make a view or a
virtual table of its name, or put a trigger on it (the database refuses,
in every way in). A table of that name in any shape other than the
server's (one renamed onto the name, one an imported package brought) is
moved aside to `timer_runs_moved_<random>` by the next run, its rows kept;
one in exactly the server's shape stays as the log, whoever made it. So an
app can at most fake rows in its own log, never reach another app's or the
server's data, and what `_timer_runs` holds is only as trustworthy as the
app's own code. Copy what you need into your own tables. The running app has no call for its timers'
settings: it reads their runs from `_timer_runs`, and an author reads the
settings with `app_timer_list`.

## The sandbox kit: work outside the app

A mini app runs TSX in the browser. Heavy or offline work beside it (convert
files, check a calculation, run a script, build a CLI tool, compile Rust to
WebAssembly) runs in a **sandbox** (`sandbox_create`, `sandbox_exec`). The
default sandbox image has every language with a short kit, so nothing needs
an install and first builds work with no network:

- **Node 26** and **Bun**: zod, date-fns, csv-parse, exceljs, cheerio,
  esbuild, typescript; biome and vitest (Bun has `bun test`).
- **Python 3.12**: pandas, numpy, pydantic, openpyxl, xlsxwriter,
  python-docx, pypdf, pdfplumber, matplotlib, plotly, scipy, pint, ezdxf,
  shapely, networkx and more; ruff and pytest.
- **Go**: modernc.org/sqlite, yaml.v3, excelize, cobra, chi, pgx, testify in
  the module cache; gofmt, go vet, staticcheck.
- **Rust**: the wasm32-unknown-unknown target, wasm-pack, wasm-bindgen,
  rustfmt, clippy; wasm-bindgen, js-sys, web-sys, serde, nalgebra, geo, dxf,
  image, csv, rusqlite, reqwest and more in the cargo cache.
- **SQLite in every language** (node:sqlite, bun:sqlite, sqlite3 +
  sqlite-utils, modernc.org/sqlite, rusqlite) and the `sqlite3` and `duckdb`
  command lines.

The exact list with versions is in the sandbox at
`/etc/mantle/sandbox-kit.json`: read it with one `sandbox_exec` (`cat
/etc/mantle/sandbox-kit.json`) instead of trying commands. `sandbox-smoke`
proves the whole kit in a few minutes. With no network, Rust needs
`CARGO_NET_OFFLINE=true` (for `cargo` and `wasm-pack` alike), and an ESM
Node or Bun project installs the kit packages it imports with `npm install
--offline --before=<kit date> <packages>` (the date is in the manifest; it
makes npm pick the kit's versions from the image's cache); Go, Python and
`require` of the Node kit need nothing extra.

**WebAssembly in an app.** The app frame may compile WebAssembly (and
nothing else is eval'd), but it has no network, so the module ships inside
the source: base64 the `.wasm` into a `.ts` file
(`export const WASM = '…'`), decode it with `atob` and call
`WebAssembly.instantiate`. With wasm-bindgen, hand those bytes to
`initSync({ module: bytes })`: the generated glue otherwise fetches the
`.wasm` by URL, and the frame refuses that. Keep it small: build `no_std`
with a C ABI (`#[no_mangle] pub extern "C" fn`) and static buffers, then
`wasm-opt -O3`; in our test a Mandelbrot engine came to about 3 KB that
way, against roughly 17 KB with std. In that test plain Rust ran about as
fast as V8 on the tight numeric loop; SIMD
(`-C target-feature=+simd128`) gave the lead.

**The boundary stays:** a sandbox works on a SQLite file inside it. It never
reaches the brain's live app databases: copy a file in with `sandbox_import`,
or read and write the app's data with the app database tools above.

## History: versions and snapshots

Every app has one numbered history line (v1, v2 …), on its **History** tab
and through `app_snapshot_list` (and `app_log`, for an audit; below).

- **Versions.** Each publish records the code that went live (source,
  manifest, the build it runs), with an optional `note`. Code only, never
  data. They stay: a version cannot be deleted.
- **Snapshots.** The code (and any draft) **and a copy of the app's
  database**, taken with `app_snapshot_create` or the History tab's
  **Take snapshot**. Mantle also takes one by itself before a restore and
  before `app_db_schema_set` changes a schema (only when the app has data).
  The automatic ones keep the newest 20 per app, and of those only as many
  as fit in `APP_SNAPSHOT_AUTO_MAX_MB` (default 1024; the newest always
  stays); the owner's own stay until deleted, within `APP_SNAPSHOT_MAX_MB`
  (default 2048) per owner. Only the owner's own (manual) snapshots count
  toward that budget: the automatic ones (before a restore, a schema change,
  a delete, an import, an MCP write, and the nightly ones) never do, and
  neither do the ones a member took before an admin approved or deleted
  their app. A member's own snapshots count toward a budget of the same
  size kept for that login (the snapshots it took).

**Restore** (`app_snapshot_restore`, or the History tab) has three modes:

| Mode   | What comes back | Where                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code` | the code        | the **draft**: preview it, then publish. The publish is a new version "restored from vN". The app's tools do not change (the app has one allowlist, the live app's): when the version declared other tools, the answer names them (`declaredTools`), and the owner grants them with `app_tools_set`. The declared schema does not come back either (it belongs to the live data). |
| `data` | the database    | live at once. If the restored data has an older schema than the app declares, the declared script runs over it on the next statement (so keep it re-runnable).                                                                                                                                                                                                                    |
| `full` | both            | live at once, the code with the build it ran on, its tools and its schema: the pair that worked together. A new version "restored vN". A draft saved with the snapshot comes back as the draft. A snapshot of an app that was never published has no build to go live with: its code goes to the draft (the answer says `code: 'draft'`) and the data goes live.                  |

Every restore first takes a snapshot of what it replaces, so it can be
undone the same way. A data restore pauses the app's database for a few
seconds (its statements answer 429 busy, and the kit retries); a code
restore over an unpublished draft needs `discard_draft`. A version holds no
data, so `data` and `full` need a snapshot.

The copies live under `APP_DB_DIR/_snapshots/<owner>/<app>/` and ride the
backup (`mantle-app-dbs-<ts>/_snapshots`). Download one from the History tab
as a `.sqlite` file.

### Audit the line: compare in place, or take it away as git

Two read tools look at the line inside Mantle. They need a read of the app
and run where `app_snapshot_list` runs (the owner, a member, a login's
workspace turn).

- `app_log` lists the entries newest first: seq, kind (version or
  snapshot), trigger, note, who (`actor`, and `actor_login_id` when the row
  names a login), when, the file count and size. It reads the rows only,
  never the code. Page on with `before_seq`; `versions_only` leaves the
  snapshots out.
- `code_diff` compares two states as unified diffs: `from` and `to` are
  `draft`, `live` (the published code) or an entry by its seq (`v3`). The
  default is `live` to `draft`: what a publish would change. An entry's side
  is the code it made live, never the draft a snapshot kept beside it. Pass
  `path` for one file. A long answer is cut and says so; a caller that may
  not see the draft gets the live code on that side, and the answer says
  `no_draft`.

`app_export` with `format: "git"` writes the versions as a git bundle (a
`.bundle` file), where a package export lands. Each version (each publish)
is one commit on `main`, oldest first. A commit holds only what a version
row never changes, so the same versions give the same commit ids on every
export: the commit time is the version's time (UTC), the message is
`vN publish` (and "Restored from vM." when it was), and the author is the
role the row names (`owner`, `member`, `agent`, `mcp`, `system`), never an
email or a person's name. What can change later rides beside the commits
as git notes (`refs/notes/commits`): the version's note (the History tab
can edit it) and the login id the row names (cleared when that login is
deleted). The bundle holds code only: no data, no draft, no declared tools,
no secret. It needs a read of the app (as a package export without data).
An app with no version yet has nothing to bundle: publish it first. A path
git may not hold (a `.git`, `.gitmodules` or `.gitattributes` name in any
of its disguises, a `:`) is left out, and the answer lists it under
`skipped`. One export reads at most 5000 versions and 256 MB of code over
all of them, and writes a bundle of at most 64 MB; each brain process runs
two at a time. Past that, compare in place with `app_log` and `code_diff`.

Whoever reads an app reads every version's code this way (and with
`code_diff`): a secret once written in the code and removed later is still
in the history. Keep secrets in the vault, never in app code.

An outside agent (Claude Code, say) takes it to its own disk with the file
download of the HTTP API and an API key ([API keys](guide/07-api/08-api-keys.md)),
then works with plain git:

```sh
curl -sfL -o app.bundle https://example.com/api/v1/files/<file_id>/download \
  -H "Authorization: Bearer mtlk_..."
git clone app.bundle my-app && cd my-app
git fetch origin 'refs/notes/commits:refs/notes/commits'   # notes and logins
git log -p            # each version, its note, and what it changed
git blame App.tsx     # which version wrote each line
git bisect start      # find the version that broke something
```

`file_id` is in `app_export`'s answer (its `hint` names the route).

**The round trip.** There is no git server and no push. To bring work back,
the agent commits on the clone, bundles the branch, uploads the file and
names it to `app_source_from_bundle`:

```sh
git commit -am "Totals per site"
git bundle create back.bundle main
curl -sf https://example.com/api/v1/files -H "Authorization: Bearer mtlk_..." \
  -F parentPath=files -F file=@back.bundle      # its answer has the file id
```

`app_source_from_bundle` (with `id` and `file_id`) writes the newest commit's
files into the app's **draft** and builds it. The live app does not change:
publishing stays its own step, with its own rights.

- **Base check.** The bundle's history must hold the commit of the app's
  live version (the id a fresh export gives it). If it does not (someone
  published since, or the work started from an older export), nothing
  changes: export again, merge the work on the new `main`, and bundle that.
  The live code is checked again inside the write.
- **The draft.** A bundle never carries a draft. When the draft holds work
  no version has, the import refuses and names the draft's `rev`: publish
  that work first and export again, or pass that rev as `base_rev` to
  replace it.
- **What it takes.** A whole branch (`git bundle create back.bundle main`;
  a range like `v3..main` is refused) of at most 64 MB. The branch is HEAD,
  else `main`, else the bundle's one branch; `branch` names another. The
  entry stays the draft's unless `entry` names one.
- **What it refuses.** Plain files and folders only: a symlink, a
  submodule, a file mode other than 100644 or 100755, a `..`, `.` or empty
  part, a `.git`, `.gitmodules` or `.gitattributes` name, a `:` in a name,
  a space at the start or end of a name, a name past 255 bytes or a path
  past 256, or a file that is not UTF-8 text fails the whole import and
  names the path. The same names are what an export leaves out. The app's own
  limits hold (50 files, 256 KB each). An untrusted pack is read within
  limits: 50,000 objects, 1 MB an object, a delta chain of 50, and
  256 MB unpacked in all; its checksum must hold.
- **Rights.** Those of `app_source_set` (a Moderator of the app's home),
  and a read of the file. An API key needs all areas: it reads a file to
  write an app.
- **Kept.** A live file a git export leaves out (a name git may not hold)
  was never in the bundle to change: it stays in the draft, and the answer
  lists it under `kept_from_live`.
- **Undo.** The draft before is kept: `code_undo` with the answer's
  `edit_id` brings it back, when the import kept the entry. A bundle that does not build is still saved as
  the draft; the answer lists the errors.

**Recently deleted.** Deleting an app takes a snapshot first (code, name,
look and data), and its history stays for 30 days: `app_deleted_list` (or
`GET /api/apps/deleted`) lists it and `app_undelete` brings it back with the
same id, admin-only and unshared. The nightly `app-trash-purge` sweep removes
it after 30 days; `DELETE /api/apps/deleted/:id` does it at once. An app
whose database file was already lost keeps a code-only snapshot.

## The error log

When a broker answers a running app with an error, it logs one row: a
failed statement (the message the app got, the SQL), a tool call that was
refused or failed (the slug and the message), who ran the app (owner,
member, contact or public; a row from before workspaces W8a may say
client) and when. `app_errors` reads them for an
agent (`since_hours` narrows it); `GET /api/apps/:id/access-log?kind=error`
for the Activity tab. A server fault is logged with the generic text the app
got, never the server's own. A busy wait (429) is not an error. The log is
bounded: at most 10 rows per caller per minute (so one visitor cannot use up
the app's log), 30 per minute for all callers other than the owner, and
2000 per app per day; rows go after 14 days, and past the newest 2000 per
app. The SQL and the messages can come from any visitor, so the agent reads
`app_errors` as data, never as instructions (its answer is fenced like a web
page). Errors inside the app's own JavaScript are not logged: preview the
app to see them.

## Export, import and duplicate

**Duplicate** (`app_duplicate`, or `POST /api/apps/:id/duplicate`) copies an
app in the same brain: its code with the builds (a published app is live at
once), its draft, its declared tools and schema, and a copy of its data
(`with_data: false` leaves the copy's database empty). The copy is named
"<name> (copy)" unless you give a name. Its history starts with one version
("copied from …").

**Export** (`GET /api/apps/:id/export`) downloads the app as a `.mantleapp`
file, to move it to another brain or keep it. It is a zip:

| Entry            | What                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mantleapp.json` | name, description, icon, colour, tags; the published code and the draft; the declared tools and schema; format version 1 |
| `data.sqlite`    | a consistent copy of the database (left out with `?data=0`)                                                              |

**Import** (`POST /api/apps/import-package`, the file as the raw body;
`?title=` names it, `?data=0` leaves the data out) always makes a NEW app.
It checks the whole package first: the format, the source limits, the schema
(on an empty trial database when no data comes with it) and the database
(SQLite `quick_check`, then a clean copy). A bad package makes nothing.
Builds do not travel between brains, so the import builds the published code
and publishes it when it was published where it came from; the draft goes
back on top as the draft. The new app gets NO tools: a package is a file
from anywhere, and its declared tools would run as the owner the moment the
app opens. The answer names them instead: `requestedToolSlugs` (this brain
has them; grant them with `app_tools_set` or the Tools tab after reading the
code) and `droppedToolSlugs` (this brain does not have them). The cap is the app
database cap (`APP_SQL_MAX_DB_MB`) plus the code.

Agents and MCP clients do the same with tools (group `apps`):
`app_duplicate`, `app_export` (saves the file under /files: an Admin
user's in Auto-filed / Exports, anyone else's at the top of Files in its
create home; returns its id and `landedIn`) and `app_import` (a `file_id`, `name`,
`with_data`). They run for any login, in its own workspaces: the scope and
the database's checks decide which apps (`OWNER_ONLY_IN_SCOPE` in
`packages/tools/src/admin-gate.ts`). The turn of an assistant of a
workspace other than Admin (a team surface) does not get them.

None of the three carries the original's grants, public link or contact
shares, history or table exports (an export has one master): the new app
is a new item, homed where it is made (the home rule in
[workspaces.md](./workspaces.md)) with no other grant. Share it again by
hand.
`POST /api/apps/import` (JSON source tree, create or update) stays for
authoring tools such as `apps:push`.

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
unchanged table never re-commits), pure SQL, no LLM. The Table of an app
written from outside the team is indexed at retrieval depth only (no facts
or entities from that text). A Contact share with Can write marks the app
as written from outside on its first write; so did a client login before
workspaces W8a. The mark is never cleared. A sync a restart interrupted is
not lost: the write marks the export dirty in Postgres, and the server
resumes it at boot. Typed columns derive
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

## App data over a user's own MCP

A user can reach an app's data from their own MCP client (Claude Code,
Claude Desktop) with `app_data_list`, `app_data_schema`, `app_data_query`
and `app_data_write`. Only an app whose **MCP access** switch is on is
reached (beside **Informational**; off by default, an admin sets it). They
reach it exactly as they run it in the browser: an app a workspace of
theirs holds, the same published build and the same read or write rule
(the grant's Write switch, never on an Informational app). Their
connection's write applies on top: a read-only grant, or a key or peer
without write, only reads.
`:host_me_*` is filled for them, so a row they write records who wrote it
the same way the app does. The details:
[mcp-as-a-login.md](./mcp-as-a-login.md).

What follows for your app:

- **The schema is yours.** MCP changes rows only, never tables or columns
  (a data-only engine lock refuses every CREATE, DROP and ALTER). Keep your
  `sqlite.schemaSql` the one place the schema is made.
- **Name things plainly** (as above): an outside model reads your tables and
  columns with `app_data_schema` before it writes.
- **Undo is a snapshot.** The first MCP write to the app in an hour saves a
  `pre_mcp_write` snapshot on its History line; an admin restores it.

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
- **`import echarts from 'echarts'`** → build error (no default export). Use
  the import `canvas_library(name, for: 'app')` gives.
- **Hardcoded colours** → looks wrong on theme switch. Theme tokens only.
- **Calling a tool not in the allowlist** → 403 at runtime; `app_build` also
  surfaces undeclared `host.tools.call(slug)` as a warning. Declare first.
- **Expecting direct brain access** → there is none. Go through a declared tool.
- **Destructive SQLite migration** → unsupported. Schema is append-only.
- **One call per row** → `Too many requests` on a busy screen. Batch reads
  and writes and save text once typing stops (see Call budget).
- **Drawing the app's own title** → the name shows twice. The host's header
  already shows the name, icon and description; start with the content.

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
> If your app needs brain data, it is for **members**: share it with their
> workspace (its Grant Access panel) and they run it from their own login.

An open link adds no grant: the app shows in a member's launcher and on
a landing page only when a workspace of theirs holds it. Anyone who has
the link, a member too, runs it there read only.

### Shared with a contact (one outsider)

Share, "Share with contact": pick one or more contacts whose sharing is on
(docs/contacts.md section 2b). Each gets their own link, opened with their
own code. The share adds no grant: the workspaces that hold the app do not
change, and nobody else gains it. The contact reads the app's SQLite
(`host.db.query`). With **Can write** on (per contact, off by default) the
contact also writes it (`host.db.exec`): the write schedules the app-table
export sync like a member's. **Informational** wins over Can write: on an app
an admin marked informational a contact only reads, as members do. Never
brain tools: `host.tools.call` is refused, except for an http tool the app
declares that an admin switched "External access" on for
(docs/member-logins.md). A contact share holds no workspace, so it never
runs a connector tool (connectors are attached to workspaces). An open
link never calls a tool. The app's Activity tab names the contact. See
docs/sharing.md section 4b.

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

Members (who runs an app: [workspaces.md](workspaces.md), "Apps") run
apps from their own shell. An app is held by the workspaces its grants
name: share it with a workspace in its Grant Access panel and publish it.
The users of every workspace that holds it then find it under Apps. They
run the green PUBLISHED build only and never edit it from there.

- **Tools:** an app any workspace other than Admin holds runs its tools at
  team rules, for every runner, an Admin user's run included; so does an
  app under the author ceiling (see "Members build apps"). Team rules allow
  a declared **read-only built-in** tool that an enabled system-wide (not
  Admin-only) tool group holds, with no confirmation and no paid model
  work. It reads through the app: what the workspaces that hold the app
  read, met with the runner's own workspaces. Recipe and shell tools are
  refused; so are http tools unless an admin switched "External access" on
  for them; so are built-ins that write or spend, and `my_items_list`,
  `my_item_open`, `summarize_text`, `extract_from_image`, `search_chunks`,
  `team_request_create` and `read_result`. Table writes are allowed (and file writes, below):
  the Table row writes `table_row_add`, `table_rows_add`,
  `table_rows_upsert`, `table_row_update` and `table_cell_set`, and
  `table_commit`, on a Table homed in the workspace that holds the app
  (exactly one workspace beside Admin; any other Table is refused, and an
  app two workspaces hold writes none). On its own workspace's Tables a
  team app is held back by nothing beyond what the user running it may do
  there: the write runs as that user, so it lands only when they may write
  the Table (its **Write** switch for their workspace, or a Moderator of
  its home). Row changes go to the Table's draft, and the app reads that
  draft back, so a second upsert before a commit updates the first's rows;
  `table_commit` publishes the draft. An app's commit keeps no history
  entry of the version it replaces, so the Table's history has no restore
  point for it. A commit that has the Table indexed again with a model
  (the Table has no summary yet, its columns or tabs changed, or its row
  count passed a power of ten) waits: while a
  pass is pending or running, and for 10 minutes after the last one,
  `table_commit` answers "This table is still being indexed; try the
  commit again in a few minutes." and the draft stays as it is. A commit
  of cell changes on a Table that has a summary only refreshes its search
  vector and is never held, so commit in batches rather than on every
  submit. An app marked **Informational** (read only) still makes these
  Table writes and commits: the Table's own rights decide them, not the
  app's flag, which governs `host.db.exec`. A call takes at most 1 MB, and a
  Table whose draft would pass 50,000 rows (or the box's table ceiling,
  when lower) or whose file is past 20 MB takes no more rows from an app.
  The Activity row of each call names the Table and the row count. A
  read-only login (a read key) writes nothing. No table create, delete or
  rename, no column, tab or snapshot change and no row delete. A shared
  link runs none of them. A connector tool runs only when
  the connector is attached to every workspace that holds the app and to a
  workspace of the runner. A connector tool without the admin's read-only
  mark is a write: it needs the connector's **Write** tick on in every
  workspace that holds the app, and in a workspace the runner moderates.
  `app_tools_set`, `app_publish` and a grant change list a warning for each
  declared tool these rules refuse.
- **Files:** a team app may also upload, replace, move and rename files in
  its own workspace: `file_upload`, `file_move` and `file_rename` (owner
  decision 2026-11-03). The same single workspace rule holds: the file and
  the folder must be homed in the one workspace beside Admin that holds the
  app, and an app two workspaces hold writes no files. The write runs as
  the user running the app and lands only where they may do it by hand: a
  new file or a move into a folder needs its **Write** switch for their
  workspace or a Moderator of its home; a replace (`overwrite: true`) or a
  rename needs edit of the file; a move needs a Moderator of the file's
  home. There is no file type allowlist. A call takes at most 16 MB of file
  (as `content_base64` or `content_text`). An upload is read into the
  brain as a Files upload is (a DWG imports as usual). A write never changes
  who can see a file: a folder another workspace also reads is refused, so
  is a move of a file another workspace reads, and so is `confirm: true`. The Activity row of each call names the folder and
  the file, never the bytes. No file or folder delete, and no folder
  create, rename or move. A read-only login writes nothing; a shared link
  runs none of them. `file_upload` runs while the system-wide **File upload
  for mini apps** group (`app-files`) is on; no agent holds it by default.
  Check out and check in: archive the old revision with `file_move` (or
  `file_rename`), then `file_upload` the new one into the same folder.
- **Data:** `host.db.query` works for every runner. A member's
  `host.db.exec` works when a workspace of theirs holds the app with
  **Write** on and an admin has not marked the app informational; else the
  write answers 403 `read-only`. Below admin a write changes ROWS only:
  declare every table and index with `app_db_schema_set`. A
  `CREATE TABLE IF NOT EXISTS` (or `CREATE INDEX IF NOT EXISTS`) on an object
  that already exists is answered as a no-op, but a new table, `ALTER`,
  `DROP`, `PRAGMA` or a transaction from a member or contact is
  refused with an error the app can catch. The database is shared by
  everyone who runs the app (not one per member): design for that. To
  record which member wrote a row, fill its columns with `:host_me_id` and
  `:host_me_name` in the SQL (see "Who is running the app"); `host.me()`
  shows the member their own name.
- **Home app:** a workspace's landing page (its screen, **Landing page**,
  set by a Moderator of it) must already be shared with that workspace
  (else 409 `landing_app_not_held`). It is the workspace's landing page
  while the workspace holds it with a green published build.
  `host.hub.get()` answers
  there too: sections are the newest pages in the member's Library, and a
  section's `token` is the page id.

## Members build apps (team apps Phase 3; one MCP surface since W7b)

A team member builds apps over their own MCP connection with the same
`app_*` tools as an admin (workspaces W7b: one MCP surface for every login;
the member-only `my_app_*` tools were retired). Read `app_authoring_guide`
(this guide) first. Every call runs in the member's own workspaces.

- **Where it lives:** `app_create` without `workspace` makes the app in the
  member's **private workspace** ("<name> (only you)", made with the
  login; the member is its only user and its Moderator), and the reply
  names it (`landedIn`). With `workspace` (one the member moderates, from
  `workspaces_list`) it lands there. Only users of its workspace read and
  run it.
- **The loop:** `app_create`, `app_file_write` (or the code tools to edit in
  place), `app_build`, `app_publish`.
  `app_db_schema_set` and `app_tools_set` declare the database and the
  tools. A tool changes an app only where the member may edit it (a
  Moderator of its workspace, or a grant with Write on).
- **Delete (the brain's trash):** `app_delete` deletes an app whose
  workspace the member moderates. Its last snapshot keeps its code, builds,
  data and history in the brain's trash (`app_deleted_list`), and
  `app_undelete` brings it back. **A delete by anyone other than the
  brain's owner is never removed by itself** (CEO decision, W6b): only the
  brain's owner deletes it for good.
- **Share with the team:** sharing is a grant, as for every brain item: in
  the app, add a grant for a workspace the member moderates from its Grant
  Access panel. Never over MCP, so no key, peer or model opens an app to
  anyone.
- **Changes reach the workspace at once:** a grant is for the app, not for
  one version. While it is shared, every `app_publish` is what the
  workspace's users run from their next open, with no new click and no
  review. Test a change on a private copy first, or remove the grant while
  you work.
- **The author ceiling:** an app a user outside the Admin workspace makes,
  duplicates or imports, or whose code or tools it changes, runs its tools
  at TEAM rules at most, for every runner, an admin included
  (`apps.author_level` 'team'; every tool broker applies it through
  `appToolLevel`). So declare read-only built-ins (or the Table row writes
  above) from an enabled system-wide (not Admin-only) group, or connector
  tools of the app's
  workspaces. `app_tools_set` warns for each tool those rules refuse. Only
  an Admin user's own "trust its tools" in the app's settings lifts it.
- **Keys and peers** never change an app's code (the risky-tool rule): a
  member builds over its own OAuth connection.

## Home apps (an app as a workspace's landing page)

Each workspace may name one published app as its **home app**: its users
get it full-screen at **Desk** while the workspace is their current one
(`GET /api/home?ws=<id>`; who runs an app: [workspaces.md](workspaces.md),
"Apps" and "The landing page") while the workspace holds it with a green
published build. A Moderator of the workspace sets it on the workspace
screen; the workspace must hold the app already. (Until task d78e7bde one
app was the home of every member, set in Team admin > Settings; migration
0276 made it the Team workspace's home app.)
Until member logins Phase 6 the same app was the team-code **Team Hub** at
`/hub`, beside the `/team` workspace and the Forum; those are retired and
redirect to `/login`. Home apps get one extra namespace, `host.hub.get()`
(site name, member name, briefing sections, Library counts),
`host.hub.openChat()`, `host.hub.openBriefing(token)`, and the built-in Desk
shows if the app ever breaks.

Everything else about building one is this guide, plus the hub-specific
contract, project structure, and content-update patterns (including the
zero-publish "tiles from a Table" pattern) in
[team-hub-app-sdk.md](team-hub-app-sdk.md), read that before building a hub
app.
