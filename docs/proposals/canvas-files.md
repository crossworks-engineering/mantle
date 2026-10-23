# Proposal: `.canvas` files (agent-drawn HTML) and a Presenter agent

Status: proposal only, 2026-10-23. Nothing here is built. Slides work stays
parked on its branches; this doc only says how a canvas would plug in later.

## 1. Recommendation (read this first)

1. **A canvas is ONE text file, `<name>.canvas`, holding one self-contained
   HTML document** (inline CSS and JS). Not a folder bundle in v1. It lives
   in the Files workspace as an ordinary `file` node, so folders, moves,
   copies, workspaces, shares, backup and search all work with no new node
   type. A multi-file bundle stays a later option (section 4.3).
2. **Render it the way mini apps already render**: a `sandbox="allow-scripts"`
   iframe with an opaque origin, served by a ticketed frame route with a
   header CSP of `default-src 'none'` and `connect-src 'none'`. No host
   bridge at all: no `host.db`, no `host.tools`. A canvas is presentation
   only.
3. **Libraries come from a vendored, pinned, offline set the brain serves**
   (`/canvas-runtime/`, beside the existing `/app-runtime/` and
   `/excalidraw-assets/`), wired in with an import map. No CDNs. An agent
   may still inline its own small code. The same set should serve mini
   apps too, and canvases get the theme tokens, Tailwind classes, a shadcn
   look and every Appearance font (sections 6.1 to 6.3).
4. **A new `presenter` specialist** authors canvases with a new `canvas`
   tool group (create, patch, read, render to PNG). Draftsman keeps charts
   and diagrams inside pages. The `specialist_routing` skill gets one plain
   line that sends every "draw / show / animate / schematic / slide" ask
   that is not a page chart to Presenter.
5. **Render to PNG through the browser sidecar that already exists**
   (browserless Chromium, driven by `puppeteer-core`), with the console
   errors handed back to the agent. This is the feedback loop mini apps lack.

## 2. Jason's question: what do we already ship?

Short answer: **nothing an agent can use inside a sandbox today.** We ship
several graphics libraries, but they are bundled into the owner UI as React
components, or run server side. The mini-app sandbox allows only React,
react-dom, lucide-react and our small UI kit.

| Library                                                                                               | Where                                                       | What it does today                                                                                                                                   | Agent-usable in a no-network iframe?                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@excalidraw/excalidraw` 0.18.1                                                                       | `server/web/package.json`, client `client/web/package.json` | The `draw` node editor (`client/web/components/draw/excalidraw-canvas.tsx`); server re-render via the sidecar ([docs/draw.md](../draw.md) section 4) | No. A full editor app, not a drawing API. Agents only read drawings (`draw-read` group: `draw_list`, `draw_get`) |
| `katex` 0.19 / 0.18                                                                                   | `server/web`, `packages/share-ui`, client `client/web`      | Page math, formulas                                                                                                                                  | CSS only: app frames load `/share-runtime/katex/katex.min.css`, but the KaTeX JS is not importable               |
| `recharts` 3.x                                                                                        | client `client/web`, `packages/web-ui` (`src/ui/chart.tsx`) | Dashboard charts                                                                                                                                     | No. Bundled into the owner UI only                                                                               |
| `@xyflow/react` 12 + `dagre`                                                                          | client `client/web`                                         | Studio graph, recall graph, trace view                                                                                                               | No. Owner UI only                                                                                                |
| `thinking-orbs`, `@firecms/neat` (WebGL), hand-written WebGL in `packages/web-ui/src/drift/engine.ts` | client, share-ui                                            | Loader orb, backdrops                                                                                                                                | No. Decorative UI                                                                                                |
| `@resvg/resvg-wasm` 2.6.2                                                                             | `packages/content` (`draw-png-render.ts`)                   | Server SVG to PNG                                                                                                                                    | Server side only                                                                                                 |
| `puppeteer-core` + `ghcr.io/browserless/chromium:v2.57.0`                                             | `server/web`, `docker-compose.yml` service `browser`        | PDF export, draw re-render, draw PNG (`server/web/lib/render-pdf.ts`, `render-draw-png.ts`, `render-sandbox.ts`)                                     | Server side; the base for `canvas_render`                                                                        |
| `esbuild`                                                                                             | `server/web`, `packages/app-build`                          | Bundles mini apps                                                                                                                                    | Build tool                                                                                                       |

**Not shipped anywhere** (checked every `package.json` in both repos):
d3, three, gsap, motion / framer-motion, anime, lottie, konva, pixi, fabric,
paper, tldraw, chart.js, echarts, visx, nivo, plotly, vega, elkjs,
cytoscape, rough.js, html2canvas. Mermaid was removed on purpose in 2026-08
([docs/diagrams.md](../diagrams.md)); the client stubs its last transitive
use (`stubs/mermaid-to-excalidraw`).

**What agents can draw today, and the limits:**

- **Draftsman** (`diagrammer`, `server/web/lib/system-manifest/manifest.ts`
  around line 1514): hand-written static SVG, uploaded with `file_create`,
  shown through `<img>`. The `diagram_design` skill
  (`server/web/lib/system-manifest/prompts.ts` line 891) forbids scripts and
  animation, and covers 27 fixed types. A P&ID or process schematic is not
  one of them. Its routing line says "every diagram or chart destined for a
  page", so a chat ask for a picture has no clear owner. That is the gap
  the owner assistant fell into when asked for a P&ID-style drawing.
- **Mini apps** (Appsmith): real React, but the bundler allowlist is
  `react`, `react-dom`, `lucide-react` plus the kit
  (`packages/app-build/src/index.ts` line 66 and line 155). No chart or
  animation library. An app also carries a database and a tool bridge, which
  is more machinery than a drawing needs.
- **`generate_image`**: raster from an image model. Not editable, not exact.

## 3. Why a canvas, and what it deliberately is NOT

A canvas is "a page of the web the agent fully controls, with nothing to
reach". Compared with what exists:

|                      | Draftsman SVG                  | `draw` (Excalidraw) | Mini app                                | **Canvas**                               |
| -------------------- | ------------------------------ | ------------------- | --------------------------------------- | ---------------------------------------- |
| Author               | agent                          | human               | agent (Appsmith)                        | agent (Presenter), human can edit source |
| Format               | static SVG file                | JSON scene          | TSX tree in `apps.source`, built bundle | one HTML text file                       |
| Scripts / animation  | no                             | no                  | yes                                     | **yes**                                  |
| Libraries            | none                           | n/a                 | React + kit only                        | vendored set (section 6)                 |
| Database             | no                             | no                  | per-app SQLite                          | **no**                                   |
| Tool calls / network | no                             | no                  | declared tools via bridge               | **no**                                   |
| Build step           | no                             | no                  | esbuild                                 | **no**                                   |
| Lives in             | Files (+ spec block in a page) | its own workspace   | its own workspace                       | **Files**                                |

A canvas never gets a database, a tool bridge, secrets, network, or a build
step. If it needs live data, it is a mini app, and Presenter should say so.
Data a canvas shows is baked in when the agent writes it (read from the
brain with the agent's normal read tools first).

## 4. Fit with the files model

### 4.1 What exists (evidence)

- A file is a `nodes` row, `type='file'`, under the `files.*` ltree; bytes on
  disk under `MANTLE_FILES_ROOT`, mirroring the folder tree
  ([docs/files.md](../files.md)). Folders are `branch` rows, max 3 levels
  (migration `packages/db/migrations/0201_item_tree.sql`).
- Writes go through `upsertFile` (`packages/files/src/ops/files.ts` line 139).
  The filename is sanitised to `[a-z0-9_-]` plus one extension, so
  `pid-unit-3.canvas` is a legal name. `overwrite=true` replaces the bytes
  and **keeps the node id**, which is why Draftsman embeds never break.
- MIME comes from the extension (`mimeForExt`,
  `packages/files/src/slug.ts` line 282).
- Small text files are also cached in `nodes.data.content` (up to 1 MB) when
  the extension is in `TEXT_EXTS` (`slug.ts` line 95).
- **No versioning.** Edits overwrite ([docs/files.md](../files.md) section 11).
- **No folder-as-one-file concept exists.** The nearest thing is the
  `.mantleapp` export, a zip of a manifest plus a SQLite file
  ([docs/app-authoring-guide.md](../app-authoring-guide.md)).
- Mini-app source is NOT in Files: it is a virtual tree in Postgres
  (`apps.source` / `apps.draft_*`, `packages/content/src/apps.ts`), max 50
  files of 256 KB.

### 4.2 Option A (recommended): one self-contained HTML file

- Extension `canvas`, MIME `text/vnd.mantle.canvas+html` (our own label, so
  no code path treats it as plain `text/html`). Add `canvas` to `TEXT_EXTS`,
  so the source is cached and readable by `file_read`.
- Cap at 1 MB (the text-cache limit). Big images go in as separate image
  files the canvas cannot fetch, so in v1 an image must be inlined as a
  `data:` URL or drawn in SVG. (A later option: let the frame route inline
  referenced brain images by id at serve time.)
- A tiny required head, so tools and the UI can read it without running it:

  ```html
  <!doctype html>
  <html>
    <head>
      <title>Unit 3 feed section, P&amp;ID</title>
      <meta
        name="description"
        content="Process flow for the unit 3 feed section, pumps P-301A/B to exchanger E-302."
      />
      <meta name="canvas:size" content="1600x900" />
      <!-- design size; the host scales to fit -->
    </head>
    <body>
      ...
      <script type="module">
        import * as d3 from 'd3'; // a bare name from the vendored set (section 6.4)
        // ...
      </script>
    </body>
  </html>
  ```

- Indexing: `.html` already goes through Tika today (`slug.ts` lines 118 to
  125). For a canvas, a small in-process extractor is better: title,
  description, and the visible text with `<script>` and `<style>` removed.
  Then the normal chunk and embed path. Search finds a canvas by its words.
- Why one file wins: every existing file feature works unchanged; an agent
  edits it with one tool; a human can open the source in the existing text
  view; diffing and backup are trivial; no new storage rules.

### 4.3 Option B: a real bundle (`name.canvas/` with `index.html`, `style.css`, `app.js`, assets)

- Needs a new idea in the files model: a folder that lists, copies, moves,
  shares, deletes, exports and indexes as one item. Every one of those paths
  (folder tree, ltree, share served-list, backup, the watcher that syncs
  disk to DB) would need a "do not descend" rule. That is weeks of edge
  cases for little gain while canvases are agent-written.
- If multi-file is needed later, copy the **mini-app pattern** instead of a
  disk folder: a `canvas` node (or a sidecar table) holding a virtual tree
  `{ entry, files }` in Postgres, like `apps.source`. Still shows in Files as
  one item.

### 4.4 Option C: a zip with a manifest (like `.mantleapp`)

- One file on disk, many files inside. But agents cannot patch a zip with
  text tools; every edit rewrites the whole archive. Good as an **export**
  format later (`canvas_export`), not as the working format.

### 4.5 Versioning

Files overwrite with no history. A canvas is mostly agent-written, so an
agent rewrite can wipe a human's hand edit. Proposal: keep the last 10
revisions in a small sidecar table (or `data.revisions`), with
`canvas_revisions` / `canvas_restore` tools. Open question 4.

## 5. Security

### 5.1 What the stack does today (evidence)

- **Raw file bytes:** `safeDownloadHeaders`
  (`packages/client-types/src/lib/safe-download.ts`) always sends `nosniff`,
  serves only an allowlist inline, and forces `text/html` to
  `application/octet-stream` + `attachment`. SVG is inline but with
  `sandbox; default-src 'none'`. **Uploaded HTML is never rendered today.**
  Keep that: the raw download route must keep treating a `.canvas` as a
  download.
- **Mini apps:** iframe `sandbox="allow-scripts"`, no `allow-same-origin`
  (share-ui `app-sandbox.tsx` line 496), `src` to a ticketed
  `/api/apps/<id>/frame` route on the brain origin, header CSP built by
  `buildAppFrameCsp` (share-ui `app-frame-html.ts`):
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' <origin>/app-runtime/ <origin>/share-runtime/; ... connect-src 'none'; base-uri 'none'; form-action 'none'`.
  The only channel out is the postMessage bridge.
- **Email HTML:** sanitised on the brain (`packages/email`, `sanitize-html`),
  shown in a `srcDoc` iframe with `sandbox="allow-popups ..."` and no
  scripts (client `client/web/components/reading-pane.tsx`).
- **The sidecar:** loads only our own render routes, with a render cookie,
  and aborts every other request (`server/web/lib/render-sandbox.ts`;
  [docs/security.md](../security.md) section 2).

### 5.2 How to render a canvas safely

Reuse the app frame plumbing, minus the bridge:

- iframe `sandbox="allow-scripts"` only. Never `allow-same-origin`,
  `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`.
- `src` to a ticketed frame route, e.g. `/api/files/<id>/canvas-frame?t=...`
  and `/s/<token>/canvas-frame?t=...` for shares. Never `srcdoc` from the
  parent (keeps the owner UI's own CSP out of it and gives one place to set
  headers).
- Header CSP:
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <origin>/canvas-runtime/; style-src 'unsafe-inline' <origin>/canvas-runtime/ <origin>/share-runtime/; img-src data: blob:; font-src data: <origin>/canvas-runtime/ <origin>/share-runtime/ <origin>/fonts/ <origin>/Inter/; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors <owner UI origins>`.
  Unlike apps, `img-src` does **not** include the brain origin, so a canvas
  cannot even fire GETs at our own API.
- The parent listens to the iframe for two messages only (`ready`, `error`,
  with `e.source` checked like apps do), and sends one (`theme`, with the
  CSS colour tokens). No other API.
- Pause offscreen canvases (`IntersectionObserver` unmounts or freezes the
  frame), and cap visible live canvases per page. A runaway loop then costs
  one frame, not the whole UI.

### 5.3 Risks that remain

- **CPU and memory abuse.** A hostile or buggy canvas can spin a core. The
  sandbox does not stop that. Mitigation: offscreen pause, "click to play"
  on shares, and a render timeout in the sidecar.
- **Fake UI / phishing inside the frame.** A canvas can draw a fake login
  box. It cannot send what is typed anywhere (`connect-src`, `form-action`,
  no popups, no top navigation), but a person could still be tricked into
  reading something false. Mitigation: a thin host frame label ("Canvas,
  made by Presenter") on shares.
- **Prompt injection into the author.** A document the agent read can steer
  what it writes into the canvas. The sandbox makes the result inert (no
  network, no bridge, no cookies). The worst case is misleading content,
  same as a page today.
- **Private data baked in.** A canvas carries whatever data the agent put in
  it. Sharing it is the same explicit act as sharing a file; workspace rules
  for members apply as for any file.
- **Public shares.** Technically safe with the frame route above, but it
  puts agent-written script in front of anonymous visitors on the brain's
  domain. Recommend v1: shares to logins and contacts only; public links
  show the PNG poster. Open question 3.

## 6. Libraries policy

|                               | Free choice from CDNs                                                | **Vendored set served by the brain**      |
| ----------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| Works on egress-blocked boxes | No. Some client boxes block egress                                   | Yes                                       |
| CSP                           | must allow third-party script hosts: supply-chain risk on every view | own origin only                           |
| Viewer privacy                | every view pings a third party                                       | none                                      |
| Reproducible                  | versions drift, URLs die                                             | pinned, renders the same in a year        |
| Agent quality                 | agents guess URLs and versions                                       | the skill lists exact names and APIs      |
| Cost                          | none                                                                 | we own the updates; a few MB in the image |

**Recommend the vendored set.** Serve pinned ESM builds from
`/canvas-runtime/<lib>@<version>/`, add an import map to the frame, and let a
canvas `import { gsap } from 'gsap'` by bare name. Same approach as the app
import map (`packages/app-build/src/build-runtime.ts`) and the self-hosted
Excalidraw fonts.

### 6.1 The set: one library per job (revised 2026-10-23 with Jason)

Sizes are rough, minified. A library loads only when a canvas imports it,
so a big one costs nothing until it is used.

| Category                      | Library        | What it is for                                                                                                                                                | Size       | Licence                                                    |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| Charts and dashboards         | Apache ECharts | Large chart catalogue, interactive, gauges, Sankey, heatmaps; Canvas or SVG output                                                                            | ~1 MB      | Apache-2.0                                                 |
| Engineering and science plots | Plotly.js      | Contour, heatmap, 3D surface, statistical plots, WebGL scatter for very large data                                                                            | ~3 to 4 MB | MIT                                                        |
| Custom drawing, schematics    | D3             | Scales, layouts, force graphs, maps, full control of the SVG. For visuals the agent must invent                                                               | ~280 KB    | ISC                                                        |
| Interactive 2D                | Konva          | Shapes people can drag, click and connect: interactive diagrams, simple editors                                                                               | ~150 KB    | MIT                                                        |
| 3D                            | Three.js       | WebGL 3D scenes: plant layouts, equipment models                                                                                                              | ~650 KB    | MIT                                                        |
| Animation                     | Motion         | Transitions and movement; has a React API too, so the same library serves mini apps                                                                           | ~40 KB     | MIT                                                        |
| Slides                        | reveal.js      | HTML slides in one file; the parked Slides plan already picked Reveal.js 6 as its player                                                                      | ~150 KB    | MIT                                                        |
| Maths                         | KaTeX          | Formulas (already shipped in `share-ui`)                                                                                                                      | ~280 KB    | MIT                                                        |
| Custom vector drawing         | plain SVG + JS | No library at all. The default choice; D3 adds data binding when needed                                                                                       | 0          | n/a                                                        |
| Interactive state             | Alpine.js      | Tabs, toggles, sliders, step-through explainers, chart filters, written as HTML attributes (`x-data`, `x-on`, `x-show`). Optional; plain JS stays the default | ~45 KB     | MIT                                                        |
| Timeline animation (maybe)    | GSAP           | The strongest timeline tool. Add only if its licence fits                                                                                                     | ~70 KB     | Free "no charge" licence, NOT OSI open source: check first |

Alpine's normal build evaluates its attribute expressions with
`new Function`, so the canvas CSP adds `'unsafe-eval'` to `script-src`. In
this frame that adds almost no risk: the frame already runs agent-written
inline script, and the boundary that matters (no network, no bridge, opaque
origin) is unchanged. The stricter `@alpinejs/csp` build avoids eval but
supports fewer expressions; use it if the audit prefers no `'unsafe-eval'`.

Considered and left out:

| Library             | Why not                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chart.js            | ECharts covers it                                                                                                                                                                        |
| anime.js            | Motion covers it                                                                                                                                                                         |
| lottie-web          | Plays designer-made After Effects files; agents cannot author them well                                                                                                                  |
| PixiJS              | Games and particles; Konva and Three cover our needs                                                                                                                                     |
| Mermaid             | Removed on purpose in 2026-08 for weak output ([docs/diagrams.md](../diagrams.md)); bringing it back competes with Draftsman                                                             |
| Slidev              | Needs a Node/Vite build; a canvas has no build step                                                                                                                                      |
| Leaflet (for later) | Map tiles come from the internet and the sandbox blocks that. Without a tile source the brain serves, it draws GeoJSON shapes with no base map. Revisit with a tile proxy if maps matter |

Rules: inline code is always allowed; nothing outside the set loads (the CSP
enforces it); adding a library is a normal release change with a pinned
version and a line in `THIRD-PARTY-NOTICES.md`.

**Mini apps have the same gap.** The app bundler allows only `react`,
`react-dom` and `lucide-react` (`packages/app-build/src/index.ts` line 66).
Build ONE vendored runtime and one import map that both canvases and mini
apps read, so a library is added once and both get it. That is a separate
change with its own branch; it should land before or with canvas P1.

### 6.4 How loading works: the agent configures nothing

- **Every canvas frame carries the same import map** listing the whole set
  (`"d3": "/canvas-runtime/d3@7.x.y/d3.min.js"`, and so on). An import map
  is only an address book: the browser fetches a library **only when the
  canvas imports it**. A canvas that uses D3 downloads D3 and nothing else.
  After the first view the file sits in the browser cache.
- **The agent just writes the import** (`import * as echarts from
'echarts'`, `import Alpine from 'alpinejs'`). No list in the head, no
  config, no version numbers. Libraries that ship only a classic browser
  build (Plotly, for one) load with
  `<script src="/canvas-runtime/plotly/plotly.min.js">`, and the skill gives
  that exact line.
- **The save tool checks it, like `app_build` does.** `canvas_create` and
  `canvas_update` scan the source for imports and runtime script tags. An
  unknown name or a CDN URL fails the call with the allowed list, so the
  agent fixes it at once instead of shipping a blank canvas. The names found
  are stored with the file (shown in the UI, used for preload hints and for
  the render).
- **Always present, because they are small or lazy:** the theme stylesheet,
  the compiled Tailwind for that canvas, the kit CSS, and the `@font-face`
  rules (a font file still loads only when text uses it).
- **Versions are the brain's, not the canvas's.** The import map points at
  the one pinned version a release ships. Upgrading a library is a release
  change; the release notes say which canvases import it, so a breaking
  upgrade can be checked with `canvas_render` before it ships.

### 6.2 CSS and the shadcn look

What mini apps get today, which a canvas can reuse:

- `/share-runtime/styles.css`: base styles and the colour tokens for every
  theme, generated from `packages/share-ui/styles/themes.css`
  (`pnpm themes:build`). The host sends the active theme into the frame
  by `postMessage`, so the tokens follow the owner's theme.
- A per-app Tailwind compile on the server (`packages/app-build/src/css.ts`,
  the `tailwindcss` `compile` API). It scans the app's own source and emits
  only the utilities it uses, mapped onto the shadcn tokens
  (`bg-card`, `text-muted-foreground`, `border-border`, `chart-1..5`).
- Six shadcn components as React code (`packages/app-build/src/kit.ts`:
  button, card, input, label, badge, separator).

For a canvas (plain HTML, no React, no build step for the agent):

1. **Tokens:** the frame links `/share-runtime/styles.css` and receives the
   theme message, exactly like an app. `var(--primary)`, `var(--card)` and
   the rest work in hand-written CSS.
2. **Tailwind classes, compiled on save:** `canvas_create` and
   `canvas_update` run the same `css.ts` compile over the canvas HTML and
   store the result next to it. The agent just writes
   `class="rounded-lg bg-card p-6 text-foreground"`. No CDN, and no
   in-browser Tailwind. This is a build step the agent never sees.
3. **shadcn components without React:** emit a small `mantle-kit.css` with
   plain classes (`.btn`, `.btn-outline`, `.card`, `.badge`, `.input`) whose
   rules come from the SAME class strings in `kit.ts`, so the look cannot
   drift from the apps. (Basecoat, an MIT library that does shadcn styling
   for plain HTML, is the alternative to check; our own file is smaller and
   tied to our tokens.)
4. **Theme on or off:** by default a canvas follows the theme.
   `<meta name="canvas:theme" content="fixed">` pins it to the light palette
   for posters and print, the way Draftsman diagrams are fixed today.

Mini apps already have points 1 and 2. They would gain from more shadcn
components in the kit (tabs, table, select, dialog, tooltip); that belongs
in the mini-app change above.

### 6.3 Fonts: every Appearance font is available

The facts:

- One registry, `packages/client-types/src/display-fonts.ts`, drives
  Settings → Appearance: 16 faces (Inter plus 15 library faces across
  sans, serif, mono and display shelves), all variable fonts.
- The files ship on the brain too: `server/web/public/fonts/library/`
  (22 woff2 files plus `licenses/`) and `server/web/public/Inter/`, served
  by the static layer (`server/web/server/static.ts` line 52, `/fonts/*` and
  `/Inter/*`).
- `displayFontFaceCss()` in the same file builds the `@font-face` block the
  share and print shells already inject.
- The app frame CSP already allows `<origin>/fonts/` for fonts.

So the frame route injects `displayFontFaceCss()` plus Inter's face, and
sets `--font-sans`, `--font-serif`, `--font-mono` and the prose font to the
owner's current choices. A canvas can then use `var(--font-sans)` (follows
the owner) or name any face, such as `"Fraunces"` or `"Big Shoulders"`.
Files load lazily, only when text paints in that face. The
`canvas_authoring` skill lists the 16 names, generated from the registry,
not typed by hand. The PNG render uses the same fonts, because the sidecar
loads the brain's own origin. That is better than Draftsman SVG today,
which shows through `<img>` and can only use system fonts.

Add `<origin>/fonts/ <origin>/Inter/ <origin>/share-runtime/` to the
canvas CSP `font-src` and `<origin>/share-runtime/` to `style-src`
(section 5.2).

## 7. The Presenter agent

### 7.1 Where it lives

All in the system manifest (`server/web/lib/system-manifest/`), so new and
existing brains get it through the normal reconcile (a new specialist is
auto-provisioned and delegation is wired):

- `MANIFEST_AGENTS`: slug `presenter`, display name Jason's call, `role:
'custom'`, `isDelegate: true`, `envModelVar: 'PRESENTER_MODEL'`,
  `toolGroupSlugs: ['canvas', 'files', 'memory-core']`,
  `skillSlugs: ['canvas_authoring', 'writing_style']`,
  `params: { temperature: 0.3, max_tokens: 32000 }` (like Draftsman),
  `memoryConfig: { max_iterations: 25 }`.
- `MANIFEST_SKILLS` + `SKILL_INSTRUCTIONS['canvas_authoring']`: the canvas
  contract (required head, size, theme tokens, reduced motion, the library
  list with one example each, no network, how to look at the render and
  fix it).
- `MANIFEST_TOOL_GROUPS`: a new `canvas` group, and a `canvas-read` group
  (list, get, show) for the persona.
- `AGENT_PROMPTS['presenter']`.

### 7.2 Tools

| Tool                             | What it does                                                                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas_create`                  | Write a new `.canvas` into a folder (default `files/canvases`), validate the head, return id and a view URL                                                                                                                         |
| `canvas_update`                  | Replace the whole source, or apply exact find-and-replace edits so the agent does not resend 50 KB for a colour change. Same id                                                                                                     |
| `canvas_get`                     | Source plus head metadata                                                                                                                                                                                                           |
| `canvas_render`                  | Render in the sidecar at the design size (or a given size and time offset for animations), return a PNG the model can see, plus captured console errors and uncaught exceptions. Optional `store: true` saves the PNG as the poster |
| `show_canvas` (in `canvas-read`) | Put a canvas in the chat as a live card (section 8)                                                                                                                                                                                 |

`canvas_render` reuses the draw rules from [docs/draw.md](../draw.md)
section 4: owner-authed only, the 2-session semaphore, timeout, cooldown on
failure, never fires `node_ingested`. Note the `browser` service is
profile-gated in `docker-compose.core.yml`; without it `canvas_render`
answers "not available" and the agent ships unseen, like mini apps today.

### 7.3 Routing, so the owner assistant stops struggling

Edit the `specialist_routing` skill (prompts.ts line 406) with one rule:

- **Draftsman**: a chart or diagram that lives in a page, with a spec block.
- **Presenter**: any other picture the user wants to see: process and P&ID
  style schematics, animated or interactive explainers, a one-off slide or
  poster, "draw me", "show me how X works". Result appears in chat and in
  Files.
- **Appsmith**: only when it needs live data, input that is saved, or tools.

Also add Presenter to `visual_answers`, and add two eval prompts
(a P&ID ask, an animation ask) to `eval:route` so the routing is measured,
not hoped for. Open question 2 asks whether to merge Draftsman into
Presenter later, which would leave one visual specialist.

## 8. Embedding

- **Files workspace:** add a `.canvas` branch to `FilePreviewBody`
  (client `client/web/app/(app)/files/file-editor.tsx` lines 385 to 444)
  before the `isText` text view, with a "Source" toggle that falls back to
  the existing text editor. Add the label in
  `packages/web-ui/src/lib/mime-label.ts`. There is no viewer registry today,
  so this is a branch, not a plug-in.
- **Pages:** markdown `![title](canvas:<file-id>)`, mirroring the existing
  `draw:<id>` image embed (client `page-editor/image.ts`). Human-writable,
  per the Pages dialect principle. In the editor it is a sandboxed iframe
  at the canvas aspect ratio. Print/PDF, DOCX, email and `/s` page shares
  use the stored PNG poster, like drawings use their snapshot.
- **Chat:** `show_canvas` returns an artifact `{ kind: 'canvas', fileId }`;
  `ArtifactView` (client `assistant/assistant-turn-parts.tsx` line 82)
  renders the live frame with an "Open" button. Telegram, the phone and
  voice get the poster PNG.
- **Slides (later, parked work untouched):** the parked deck model is JSON
  elements on a 1920x1080 stage with a Reveal.js player and a
  `slide_render` PNG via the same sidecar. A canvas becomes one more element
  type, `{ type: 'canvas', fileId, region }`, rendered by the same frame.
  Presenter can also author a whole slide as a 1920x1080 canvas. No change
  to the Slides branches is needed for canvases to ship first.

## 9. Open questions for Jason

1. **One file or a bundle?** I recommend one self-contained HTML file in v1
   (section 4.2), with the app-style virtual tree as the upgrade path. Is a
   real folder bundle a must for you, and why (assets, size, human editing)?
2. **A new Presenter, or give Draftsman the canvas tools?** Two visual
   specialists can recreate the routing confusion. My pick: new Presenter
   now, with the one-line routing rule, and decide on a merge after the
   eval numbers.
3. **Public shares of canvases in v1?** My pick: no, poster PNG on public
   links; live canvases for logins and contacts.
4. **History:** keep the last 10 revisions, or plain overwrite like files?
5. **Library set:** approve the set in section 6.1, now with Alpine.js. Is GSAP's licence
   fine for a public, commercially licensed repo, or is Motion enough?
6. **Display name** for the agent (Presenter is a placeholder).
7. **The sidecar:** it is optional in `docker-compose.core.yml`. Make it
   required wherever Presenter is enabled, or accept "no render" on such
   boxes?

## 10. Phased plan (rough sizes, one developer)

| Phase                | Scope                                                                                                                                                                                                                                                | Repo  | Size        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| P0 Spike             | A hand-written `.canvas` in Files; frame route with the CSP; open it in the client. Prove the sandbox, theme message, import map                                                                                                                     | both  | 1 to 2 days |
| P1 Format and viewer | `canvas` ext, MIME, `TEXT_EXTS`; frame routes (owner + share) and ticket; `/canvas-runtime/` with the vendored set and import map; extractor for indexing; Files viewer branch + source toggle; contract bump (share-ui frame builder, client-types) | both  | 4 to 6 days |
| P2 Agent             | `canvas` and `canvas-read` groups and tools; `/render/canvas/:id` + `canvas_render` with console capture; `presenter` agent, `canvas_authoring` skill, routing edits; `eval:route` cases                                                             | brain | 4 to 5 days |
| P3 Embeds            | `canvas:` page embed + poster fallback for print, DOCX, email and `/s`; `show_canvas` chat card; shares to logins and contacts                                                                                                                       | both  | 3 to 4 days |
| P4 Later             | Revisions; Slides element (when Slides resumes); optional bundle tree; `canvas_export` zip                                                                                                                                                           | both  | per item    |

Each phase lands with an independent read-only security audit on a fixed
commit, as for other security-sensitive work, since this is the first
feature that runs agent-written script in front of people.
