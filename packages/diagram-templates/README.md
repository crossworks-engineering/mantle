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
- `test` runs the unit tests (validation, static export, canvas round trip,
  tees and branches, and the pin that keeps older drawings byte for byte).

Open `templates/*.canvas.html` straight from disk in a browser: it draws with
no server and no network.

## Package layout

| Path                                    | What it is                                                           |
| --------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                          | `render`, `validate`, `TEMPLATES`, `buildCanvas`, `checkStaticSvg`   |
| `src/browser.ts`                        | `mount()`: reads the data block, renders, exposes `window.diagram`   |
| `src/canvas.ts`                         | the canvas file: build, read and replace the data block              |
| `src/runtime/style.ts`                  | the house style as code: palette, node kinds, font roles, grid       |
| `src/runtime/text.ts`                   | text measurement (real in the browser, an estimate in Node) and wrap |
| `src/runtime/layered.ts`                | dagre layout plus the channel and track router for `flow`            |
| `src/runtime/grid-router.ts`            | A* orthogonal router on an 8px grid for `pid` pipes and signals      |
| `src/runtime/geom.ts`                   | boxes, segments, hops and the layout self-check                      |
| `src/runtime/svg.ts`, `export.ts`       | string SVG builder (no scripts possible) and the static check        |
| `src/runtime/validate.ts`               | checks with exact paths and "did you mean"                           |
| `src/templates/flow.ts`                 | the `flow` template                                                  |
| `src/templates/pid/`                    | the `pid` template: schema, site profile, symbols, render, sets      |
| `src/runtime/pages.ts`                  | a drawing set stacked into one static SVG, and its page references   |
| `scripts/build.ts`, `scripts/render.ts` | the bundle build and the Chromium harness                            |
| `samples/`                              | sample data, an example site profile, and the rendered results       |

## Libraries and sizes

| Library                                     | Version        | Licence      | Use                                                               | Size in the bundle   |
| ------------------------------------------- | -------------- | ------------ | ----------------------------------------------------------------- | -------------------- |
| `@dagrejs/dagre` (with `@dagrejs/graphlib`) | 3.1.1 (pinned) | MIT          | ranks, ordering and coordinates (layered layout, compound groups) | about 48 KB minified |
| our code                                    |                | repo licence | style, routing, templates, export, checks                         | about 80 KB minified |

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
    <meta name="description" content="One sentence on what it shows." />
    <meta name="canvas:size" content="fill" />
    <meta name="canvas:theme" content="fixed" />
    <!-- diagrams use the light skin only -->
    <meta name="diagram:template" content="pid@1" />
    <style>
      ...
    </style>
  </head>
  <body>
    <main id="diagram"></main>
    <!-- the live drawing -->
    <div id="diagram-errors" role="alert"></div>
    <!-- data errors, shown in the page -->
    <script type="application/json" id="diagram-data">
      { ...THE DATA... }
    </script>
    <script>
      /* the runtime, inline */
    </script>
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
  `role="img"`, `aria-labelledby` (the title) and `aria-describedby` (the desc), then `<title>` and `<desc>` first;
- system font stacks only (each `font-family` ends in a generic family);
- arrowheads, hops and signal marks are plain paths, not markers or patterns.

## Data contract: `flow`

Boxes and arrows: process flows, flowcharts, architecture, data flow.

| Field           | Type                                                                               | Notes                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `template`      | `"flow"`                                                                           | optional echo                                                                                                                   |
| `title`         | string, up to 80                                                                   | required; the `<title>`, and drawn at the top unless `showTitle: false`                                                         |
| `description`   | string, up to 300                                                                  | one sentence on what it shows (the `<desc>`); a warning when missing                                                            |
| `direction`     | `right` (default) or `down`                                                        | rank direction                                                                                                                  |
| `nodes[]`       | 1 to 40                                                                            | `id`, `label` (wraps to 3 lines), `sublabel`, `tag` (a small caps line), `kind`, `shape`, `group`                               |
| `nodes[].kind`  | `backend` (default), `focal`, `store`, `external`, `input`, `optional`, `security` | the style guide's node treatments                                                                                               |
| `nodes[].shape` | `box` (default), `pill`, `diamond`, `cylinder`                                     |                                                                                                                                 |
| `edges[]`       | up to 80                                                                           | `from`, `to`, `label` (14 characters read best), `style` (`solid`, `dashed`), `tone` (`muted`, `accent`, `link`), optional `id` |
| `groups[]`      | up to 12                                                                           | `id`, `label`, `parent` (nesting), `kind` (`boundary`, `security`)                                                              |
| `legend`        | `true` (default), `false`, or names                                                | names override labels: `{ "dashed": "Back to the data", "focal": "Main store" }`                                                |

Budget (warnings): 9 nodes, 12 edges, 2 accent elements (focal nodes plus
accent edges). Errors: unknown fields, dangling ids, self loops, duplicate
ids, group loops.

## Data contract: `pid`

A P&ID first draft, following `docs/diagram-guides/mantle/type-pid.md`.

| Field                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `description`, `showTitle`, `legend` | as for `flow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `legendNames`                                 | `{ main?, secondary? }`: the legend's names for the two line weights when they are not process and utility lines (a traced circuit: `Main process line`, `Process branch or deadleg`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sheet`                                       | `{ number, revision }`: top right, and in the `<desc>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `profile`                                     | the site profile (below), passed in as data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `equipment[]`                                 | `id` (the tag, `V-101`), `type`, `service` (`FEED SURGE DRUM`), `focal`, layout hints `column` (0 is leftmost) and `row` (`base`, `below`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `equipment[].type`                            | `vertical-vessel`, `horizontal-drum`, `column`, `tank`, `centrifugal-pump`, `pd-pump`, `compressor`, `shell-tube-exchanger`, `exchanger`, `air-cooler`, `filter`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `offpage[]`                                   | `id`, `direction` (`in`, `out`), `sheet`, `text` (`TO E-201`). A connector whose pipes are all utility lines sits beside its equipment; others sit on the sheet edge. A second pipe to the same connector joins the first with a tee and a join dot                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lines[]`                                     | `number` (the user's line number, exactly), `from` (equipment, connector or tee), `to` (equipment, connector, tee, or an instrument tag: the bubble sits at the branch end), `fromPort`, `toPort` (`top`, `bottom`, `left`, `right`), `service`, `weight` (`main`, `secondary`), `inline[]`, `focal`, optional `id` (defaults to the number); `end` (`open`, `cap`: the line stops, with no `to`), `deadleg` (a cap unless it ends elsewhere, and a DL tag), `toward` (`up`, `down`, `left`, `right`: the way a line that stops leaves), `note` (a short note drawn beside the line, up to 32 characters: an honesty mark such as `INFERRED JOIN (GUESS)`) |
| `tees[]`                                      | `id` (a tag), `on` (the parent line's id or number), `near` (`from`, `to`). A line that starts or ends at a tee is a branch: a header take-off, a drain, a vent, a dead leg, a gauge tapping, a bypass (two tees on one line)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lines[].inline[]`                            | `type` (`gate`, `globe`, `ball`, `butterfly`, `check`, `three-way`, `control`, `relief`, `reducer`, `blind`, `orifice`), `tag` (`LV-101`), `actuator` (`diaphragm`, `piston`, `motor`), `fail` (`FO`, `FC`, `FL`), `closed` (normally closed), `focal`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `instruments[]`                               | `tag` (ISA-5.1 letters then loop number, `LIC-101`), `on` (an equipment id, or a line id or number), `location` (`field`, `control-room`, `local-panel`, `behind-panel`), `display` (`discrete`, `shared`, `computer`, `plc`, `interlock`), `setpoint`, `focal`                                                                                                                                                                                                                                                                                                                                                                                            |
| `signals[]`                                   | `from`, `to` (instrument tags or tagged inline items), `type` (`electric`, `pneumatic`, `data`, `capillary`, `hydraulic`, `connection`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `circuits[]`                                  | `id`, `label`, `lines[]`, `equipment[]`, `colour` (`series-1` to `series-5` or `#rrggbb`); a line belongs to one circuit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
- tag letters are checked against ISA-5.1 (`CIF` is an error, `FIC` reads);
- tees and branches: once a parent pipe and its valves are down, each tee
  takes a grid point ON that pipe (clear of its valves, corners, crossings
  and other tees; by default where its branch leaves most directly, or
  toward `near`), so the join dot cannot drift off the line, and a self-check
  warns if it ever did. Branches are routed after their parents, in depth
  order, on the same grid with equipment, labels and valves blocked, leaving
  square to the parent. A stub (or a branch to a bubble) is a straight run
  on the first side with room; a stub's tee is picked where the stub fits.
  A connector reached only through a tee is placed beside it. Data with no
  tees takes none of this path and draws byte for byte as before
  (`src/unchanged-output.test.ts` pins it).

Budget (warnings, from the guide): 8 equipment, 16 bubbles, 20 valves, 5
loops, 12 lines, 4 line types, 2 accents. Over budget: split the sheet.

### Drawing sets

A `pid` input with `pages` is a set: several sheets in one canvas that link
to each other (`src/templates/pid/set.ts`). A traced circuit
(`circuit_trace`) is one, an overview and then a page per sheet, unless one
page holds the whole circuit.

| Field                                           | Notes                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `title`, `description`                          | the set's own; `description` is the stacked export's `<desc>`                                                                |
| `profile`, `legendNames`, `legend`, `showTitle` | defaults for every page that does not set its own; a problem in one is said once                                             |
| `pages[]`                                       | 1 to 40: `id` (a short tag), `title` (the page button and the export header, up to 60), `data` (ordinary `pid` data)         |
| `offpage[].link`, `offpage[].focus`             | inside a set only: the page the connector continues on, and the line, equipment, connector or tee to show there              |
| `lines[].more`                                  | `{ text, link?, focus? }`: a "more here" marker beside the line (`+7 DEADLEGS`); a single drawing may carry one without link |

The check resolves every link: a page that is not there, a focus that names
nothing on its page, or a link to its own page without a focus is an error
with its path. Each link is printed as a page reference (`SEE PAGE 3:
<title>`) under its connector or in its marker, so a static copy still says
where every line goes.

The canvas shows one page at a time under one row of page buttons (it scrolls
sideways when they do not fit; a host keeps `SET_NAV_HEIGHT` for it), with Back
and Overview; a click (or Enter) on a linked connector or marker shows its
page and outlines the `focus` element; the arrow keys and Page Up/Down step
through the pages (so `present_render` with `slide: n` shows page n). A link
only switches the canvas's own page: nothing is fetched, no URL is opened and
the window is never navigated. `window.diagram.exportSvg()` returns every
page stacked under a `PAGE n OF m: <title>` header (the static export,
`present_export`); `window.diagram.exportPageSvg(id?)` one page;
`window.diagram.pages`, `.page` and `.show(id, focus?)` drive it. Single
drawings are untouched: the pin in `src/unchanged-output.test.ts` holds, and
`src/pid-set.test.ts` pins the set.

### Site profile

Client conventions are client data: a profile lives in each brain and is
passed in `profile`. It never goes in this repo. `samples/profiles/example-site.json`
is a made-up example.

| Field                    | Effect                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | shown nowhere yet; for the author                                                                                                                                                                      |
| `lineNumber`             | `{ pattern, example, enforce }`: a regular expression with named groups (`size`, `service`, `seq`, `class`); `service` sets the line's service; `enforce: "error"` refuses a number outside the format |
| `colourByService`        | colour lines by service (monochrome otherwise)                                                                                                                                                         |
| `serviceColours`         | service code to colour (`ST: "series-4"`)                                                                                                                                                              |
| `instrumentFirstLetters` | extra first letters the site uses (`X`)                                                                                                                                                                |
| `symbols`                | `normallyClosed` (`text`, `filled`), `checkValve` (`filled`, `arrow`), `corners` (`square`, `round`), `crossing` (`hop`, `gap`), `deadleg` (`cap`, `dashed`)                                           |
| `customSymbols`          | replace a built-in equipment or valve drawing: `{ w, h, paths: [{ d, fill }] }`; path data only, checked                                                                                               |

## How an agent uses it

The Draftsman and the Presenter (`server/web/lib/system-manifest`, skills
`diagram_design` and `canvas_authoring`) use the brain's tools
(`packages/tools/src/builtins-presents.ts`):

1. **Pick** the template: `flow` for boxes and arrows, `pid` for a P&ID.
   Would a table say it better? Then do not draw.
2. **Read the contract**: `diagram_guide` with the type returns the
   template's data contract and a complete example
   (`docs/diagram-guides/mantle/type-flow.md`, `type-pid.md`), and the
   brain's site profile, whose `json profile` block is filled in as the
   data's `profile`.
3. **Render**: `diagram_render({ template, data })` validates (every problem
   at once, as the tool's error), draws the data in the brain's browser
   sidecar and returns the picture, the warnings and the stats.
4. **Fix the data**, not the picture: shorten a label, merge two nodes,
   split the sheet, set a `fromPort`/`toPort`, move equipment with `column`
   or `row`, change `direction`. Render again. Stop when the warnings are
   empty or only ones you accept.
5. **Save**: `present_create({ template, data })` stores the canvas (the
   editable source; `import` mode, the runtime comes from the canvas library
   set); `present_export` writes the static SVG into `files/diagrams` for the
   page, built fresh from the stored data.

## What is left

- Circuits drawn as a hull around their items instead of a box: the
  self-check now warns when a circuit's box takes in other items.
- Layout quality on dense sheets: `samples/pid-column-site-profile.json`
  renders with its warnings (a busy middle, 27 crossings). Next steps: signal
  routing that prefers the side of the loop, and a second layout pass that
  moves a controller when its signals cross.
- The pid data model: nozzle ids and elevations, instrument loops across
  sheets, more equipment types. Tees sit on a pipe's straight runs only, not
  on a corner (a cross or an elbow tee), and a bypass's tees are placed by
  `near`, not by the valve they bypass.
- More templates on the same runtime: sequence, swimlane, state, tree.
