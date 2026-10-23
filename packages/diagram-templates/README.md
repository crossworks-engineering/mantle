# @mantle/diagram-templates

The agent writes **data**, not geometry. A template lays the data out, routes
every line with right angles, measures every label, draws it in the house
style, checks its own picture, and exports a static SVG that survives pages,
print, PDF, Word, email and public shares.

Each template is a self-contained **Present canvas** (one HTML file, no
network). The data sits in one JSON block in that file; the file stays the
editable source, the SVG is the export.

```
data (JSON) --> validate --> layout (dagre) --> route (orthogonal) --> draw (house style)
                   |                                                       |
                   v                                                       v
            errors with a fix                       self-check warnings + static SVG + PNG
```

## Quick start

```bash
pnpm -C packages/diagram-templates build
```

```bash
pnpm -C packages/diagram-templates render --all
```

```bash
pnpm -C packages/diagram-templates test
```

- `build` bundles the browser runtime into `dist/` and writes the blank
  templates `templates/flow.canvas.html` and `templates/pid.canvas.html`.
- `render` opens each `samples/*.json` in headless Chromium and writes
  `samples/out/<name>.svg`, `.png` and `.report.json`. Exit 1 on a data
  error, a console error, any network request, or a non-static export.
  `--chrome <path>` picks a local Chrome; `--ws ws://host:3000` uses a
  browserless service (the `mantle_browser` sidecar on a brain).
- `test` runs the unit tests (validation, static export, canvas round trip).

Open `templates/*.canvas.html` straight from disk in a browser: it draws with
no server and no network.

## Package layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | `render`, `validate`, `TEMPLATES`, `buildCanvas`, `checkStaticSvg` |
| `src/browser.ts` | `mount()`: reads the data block, renders, exposes `window.diagram` |
| `src/canvas.ts` | the canvas file: build, read and replace the data block |
| `src/runtime/style.ts` | the house style as code: palette, node kinds, font roles, grid |
| `src/runtime/text.ts` | text measurement (real in the browser, an estimate in Node) and wrap |
| `src/runtime/layered.ts` | dagre layout plus the channel and track router for `flow` |
| `src/runtime/grid-router.ts` | A* orthogonal router on an 8px grid for `pid` pipes and signals |
| `src/runtime/geom.ts` | boxes, segments, hops and the layout self-check |
| `src/runtime/svg.ts`, `export.ts` | string SVG builder (no scripts possible) and the static check |
| `src/runtime/validate.ts` | checks with exact paths and "did you mean" |
| `src/templates/flow.ts` | the `flow` template |
| `src/templates/pid/` | the `pid` template: schema, site profile, symbols, render |
| `scripts/build.ts`, `scripts/render.ts` | the bundle build and the Chromium harness |
| `samples/` | sample data, an example site profile, and the rendered results |

## Libraries and sizes

| Library | Version | Licence | Use | Size in the bundle |
| --- | --- | --- | --- | --- |
| `@dagrejs/dagre` (with `@dagrejs/graphlib`) | 3.1.1 (pinned) | MIT | ranks, ordering and coordinates (layered layout, compound groups) | about 48 KB minified |
| our code | | repo licence | style, routing, templates, export, checks | about 80 KB minified |

The whole runtime is one 129 KB script (`dist/diagram-runtime.js`), so a
template canvas with its data is about 135 KB, well under the 1 MB canvas
limit. Build-time only: `esbuild`, `puppeteer-core` (both already in the repo).

**Why not ELK.js:** elkjs is licensed EPL-2.0 or GPL-3.0, not MIT, Apache or
BSD, and its bundle (about 1.4 MB) alone is over the 1 MB canvas limit. dagre
does the graph part; the orthogonal routing ELK would have given is written
here (`layered.ts`, `grid-router.ts`). If ELK is ever wanted for its layered
routing quality, it needs a licence decision first.

## The canvas contract

A template file is a valid Present canvas (`docs/proposals/canvas-files.md`
section 4.2):

```html
<!doctype html>
<html lang="en">
<head>
  <title>Feed surge drum level control</title>
  <meta name="description" content="One sentence on what it shows.">
  <meta name="canvas:size" content="fill">
  <meta name="canvas:theme" content="fixed">          <!-- diagrams use the light skin only -->
  <meta name="diagram:template" content="pid@1">
  <style>...</style>
</head>
<body>
  <main id="diagram"></main>                           <!-- the live drawing -->
  <div id="diagram-errors" role="alert"></div>         <!-- data errors, shown in the page -->
  <script type="application/json" id="diagram-data">{ ...THE DATA... }</script>
  <script>/* the runtime, inline */</script>
</body>
</html>
```

- **Runtime modes.** `inline` (default): the runtime is in the file, so it
  works anywhere, offline, from `file://`, and inside the Present frame
  (`script-src 'unsafe-inline'`). `import`: the file holds
  `import { mount } from '@mantle/diagram-templates/browser'` and needs the
  brain's canvas import map to serve `dist/diagram-runtime.mjs`; the file
  then shrinks to its data.
- **Editing.** Change only the data block: `replaceCanvasData(html, data)`
  rewrites the block and keeps `<title>` and the description in step.
  `readCanvasData(html)` reads it back.
- **In the page** (`window.diagram`): `ready` (a promise of the outcome),
  `exportSvg()`, `errors`, `warnings`, `stats`.
- **Frame messages.** None of its own. On load the frame's prelude sends
  `{v:1, kind:'ready'}`. Bad data shows its errors in the page and throws one
  `diagram: ...` error, which the prelude reports as `{v:1, kind:'error'}`.

## The export

`exportSvg()` returns one static SVG, built as escaped text (no live DOM is
serialised). `checkStaticSvg(svg)` proves it, and the tests and the harness
run it on every result:

- no `script`, `foreignObject`, `image`, `use`, `a`, `style`, animation or
  event handler; no `href` or `url()` other than `#id`; no `@import`;
- root `<svg>` with `xmlns`, `viewBox`, matching `width` and `height`,
  `role="img"` and `aria-labelledby`, then `<title>` and `<desc>` first;
- system font stacks only (each `font-family` ends in a generic family);
- arrowheads, hops and signal marks are plain paths, not markers or patterns.

## Data contract: `flow`

Boxes and arrows: process flows, flowcharts, architecture, data flow.

| Field | Type | Notes |
| --- | --- | --- |
| `template` | `"flow"` | optional echo |
| `title` | string, up to 80 | required; the `<title>`, and drawn at the top unless `showTitle: false` |
| `description` | string, up to 300 | one sentence on what it shows (the `<desc>`); a warning when missing |
| `direction` | `right` (default) or `down` | rank direction |
| `nodes[]` | 1 to 40 | `id`, `label` (wraps to 3 lines), `sublabel`, `tag` (a small caps line), `kind`, `shape`, `group` |
| `nodes[].kind` | `backend` (default), `focal`, `store`, `external`, `input`, `optional`, `security` | the style guide's node treatments |
| `nodes[].shape` | `box` (default), `pill`, `diamond`, `cylinder` | |
| `edges[]` | up to 80 | `from`, `to`, `label` (14 characters read best), `style` (`solid`, `dashed`), `tone` (`muted`, `accent`, `link`), optional `id` |
| `groups[]` | up to 12 | `id`, `label`, `parent` (nesting), `kind` (`boundary`, `security`) |
| `legend` | `true` (default), `false`, or names | names override labels: `{ "dashed": "Back to the data", "focal": "Main store" }` |

Budget (warnings): 9 nodes, 12 edges, 2 accent elements (focal nodes plus
accent edges). Errors: unknown fields, dangling ids, self loops, duplicate
ids, group loops.

## Data contract: `pid`

A P&ID first draft, following `docs/diagram-guides/mantle/type-pid.md`.

| Field | Notes |
| --- | --- |
| `title`, `description`, `showTitle`, `legend` | as for `flow` |
| `sheet` | `{ number, revision }`: top right, and in the `<desc>` |
| `profile` | the site profile (below), passed in as data |
| `equipment[]` | `id` (the tag, `V-101`), `type`, `service` (`FEED SURGE DRUM`), `focal`, layout hints `column` (0 is leftmost) and `row` (`base`, `below`) |
| `equipment[].type` | `vertical-vessel`, `horizontal-drum`, `column`, `tank`, `centrifugal-pump`, `pd-pump`, `compressor`, `shell-tube-exchanger`, `exchanger`, `air-cooler`, `filter` |
| `offpage[]` | `id`, `direction` (`in`, `out`), `sheet`, `text` (`TO E-201`). A connector whose pipes are all utility lines sits beside its equipment; others sit on the sheet edge. A second pipe to the same connector joins the first with a tee and a join dot |
| `lines[]` | `number` (the user's line number, exactly), `from`, `to` (equipment or connector), `fromPort`, `toPort` (`top`, `bottom`, `left`, `right`), `service`, `weight` (`main`, `secondary`), `inline[]`, `focal`, optional `id` (defaults to the number) |
| `lines[].inline[]` | `type` (`gate`, `globe`, `ball`, `butterfly`, `check`, `three-way`, `control`, `relief`, `reducer`, `blind`, `orifice`), `tag` (`LV-101`), `actuator` (`diaphragm`, `piston`, `motor`), `fail` (`FO`, `FC`, `FL`), `closed` (normally closed), `focal` |
| `instruments[]` | `tag` (ISA-5.1 letters then loop number, `LIC-101`), `on` (an equipment id, or a line id or number), `location` (`field`, `control-room`, `local-panel`, `behind-panel`), `display` (`discrete`, `shared`, `computer`, `plc`, `interlock`), `setpoint`, `focal` |
| `signals[]` | `from`, `to` (instrument tags or tagged inline items), `type` (`electric`, `pneumatic`, `data`, `capillary`, `hydraulic`, `connection`) |
| `circuits[]` | `id`, `label`, `lines[]`, `equipment[]`, `colour` (`series-1` to `series-5` or `#rrggbb`); a line belongs to one circuit |

What the template does with it:

- vessels stand on a common baseline, pumps sit below, exchangers sit at the
  height of the pipes they join; liquid leaves a vessel's bottom to its pump,
  a pump discharges from its tangential nozzle;
- pipes are routed on the grid, main lines first, never through a symbol or a
  label and never on top of another pipe; crossings get a hop (or a gap);
- valves go on the longest straight run of their pipe, clear of other pipes;
  the line number goes on a free stretch above a horizontal run;
- a bubble with `on` sits beside what it measures with a straight connection;
  a controller sits near the middle of its loop;
- tag letters are checked against ISA-5.1 (`CIF` is an error, `FIC` reads).

Budget (warnings, from the guide): 8 equipment, 16 bubbles, 20 valves, 5
loops, 12 lines, 4 line types, 2 accents. Over budget: split the sheet.

### Site profile

Client conventions are client data: a profile lives in each brain and is
passed in `profile`. It never goes in this repo. `samples/profiles/example-site.json`
is a made-up example.

| Field | Effect |
| --- | --- |
| `name` | shown nowhere yet; for the author |
| `lineNumber` | `{ pattern, example, enforce }`: a regular expression with named groups (`size`, `service`, `seq`, `class`); `service` sets the line's service; `enforce: "error"` refuses a number outside the format |
| `colourByService` | colour lines by service (monochrome otherwise) |
| `serviceColours` | service code to colour (`ST: "series-4"`) |
| `instrumentFirstLetters` | extra first letters the site uses (`X`) |
| `symbols` | `normallyClosed` (`text`, `filled`), `checkValve` (`filled`, `arrow`), `corners` (`square`, `round`), `crossing` (`hop`, `gap`) |
| `customSymbols` | replace a built-in equipment or valve drawing: `{ w, h, paths: [{ d, fill }] }`; path data only, checked |

## How an agent uses it (the future short skill)

1. **Pick** the template: `flow` for boxes and arrows, `pid` for a P&ID.
   Would a table say it better? Then do not draw.
2. **Fill** the data from what the user gave. Never invent a tag, a line
   number or a set point. For `pid`, read the site profile from the brain and
   pass it as `profile`.
3. **Render** (the future `diagram_render` tool: harness logic on the
   brain's `mantle_browser`). It returns errors, or the SVG, a PNG, the
   warnings and the stats.
4. **Inspect** the PNG and the warnings. Each warning names the thing to fix:
   `label of X sits on Y`, `line L runs behind B`, `no free stretch for the
   line number`, `budget: 11 nodes`.
5. **Fix the data**, not the picture: shorten a label, merge two nodes, split
   the sheet, set a `fromPort`/`toPort`, move equipment with `column` or
   `row`, change `direction`. Render again. Stop when the warnings are empty
   or only ones you accept.
6. **Save**: the canvas file (the source) and the SVG plus PNG for the page.

## How it plugs in

**Present** (branch `claude/present-workspace-6f9157`):

- A template is a canvas as it stands (inline mode). To serve the runtime
  once instead of in every file: add an entry to `CANVAS_MODULES` in
  `packages/app-build/src/canvas-runtime.ts`, specifier
  `@mantle/diagram-templates/browser`, source
  `export * from '@mantle/diagram-templates/browser';`, and build canvases
  with `mode: 'import'`.
- The frame's `ready` and `error` messages already cover it; no new message.
- The poster render can call `window.diagram.exportSvg()` and store the SVG
  next to the PNG poster.

**Draftsman** (`diagrammer`, skill `diagram_design`):

- New tools: `diagram_render({ template, data })` (validate, render in the
  sidecar, return SVG, PNG and warnings) and `diagram_save` (store the canvas
  and the SVG in `files/diagrams`, embed the SVG in the page). The page's
  `diagram` spec block becomes the JSON data.
- The skill shrinks to the loop above plus the two data contracts; the house
  style rules now live in `src/runtime/style.ts` and are enforced by code.
- The guide tools from branch `claude/adoring-tu-03d012`
  (`diagram_types`, `diagram_guide`) stay for content advice; the P&ID base
  guide is what the `pid` template implements.

## What is left

- Draftsman tools (`diagram_render`, `diagram_save`) and the shorter skill.
- Export through `mantle_browser` on the brain: the harness logic as a
  server module next to `server/web/lib/render-*.ts`, with the canvas loaded
  by `setContent` and every request refused, as `scripts/render.ts` does.
- Site profiles: where a brain keeps its profile (a Recall map or a table),
  and a tool to read it.
- `pnpm licenses:notices` once dagre lands on main (the notices file is
  generated for the whole repo, so it is not regenerated on this branch).
- Layout quality on dense sheets: `samples/pid-column-site-profile.json`
  renders with 4 warnings and a busy middle. Next steps: signal routing that
  prefers the side of the loop, circuits drawn as a hull instead of a box,
  and a second layout pass that moves a controller when its signals cross.
- More templates on the same runtime: sequence, swimlane, state, tree.
