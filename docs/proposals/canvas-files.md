# Proposal: the Present workspace (agent-drawn HTML canvases) and a Presenter agent

Status: proposal only, 2026-10-23. Nothing here is built. The Slides work
stays parked on its branches. This doc started as "`.canvas` files in
/files"; after review with Jason it became a workspace of its own, Present,
which also takes the place of the planned Slides workspace (section 9).

## 1. Recommendation (read this first)

1. **Present is a workspace kind, like Pages, Tables, Draw and Apps.** Each
   item is a **canvas**: one self-contained HTML document (inline CSS and
   JS) that can draw, animate, run a chart, a 3D scene, or a slide deck.
   A deck is just a canvas with slides. One item type, one viewer, one
   agent. Draw is the template to copy (sidecar table, picture snapshot,
   render route, share route, page embed).
2. **A canvas runs live in two places only:** its own Present view
   (`/present/<id>`, with Maximise, Full screen, Replay, Source, Share) and a
   share link (`/s/<token>`, full screen). Everywhere else (pages, chat,
   Telegram, PDF, DOCX) it appears as a **PNG poster**, and clicking the
   poster opens the real canvas. No live embeds.
3. **The live view is a sandbox**, the way mini apps already run: an
   `allow-scripts`-only iframe with an opaque origin, served by a ticketed
   frame route with a header CSP of `default-src 'none'` and
   `connect-src 'none'`. No host bridge: no database, no tools, no network.
   A canvas is presentation only.
4. **Latest is latest.** No draft and commit. A save is live at once,
   including on share links, like a shared file (Jason, 2026-10-23).
5. **Libraries come from a vendored, pinned, offline set the brain serves**,
   wired in with an import map; the agent just writes `import`. Canvases
   also get the theme tokens, Tailwind classes, a shadcn look and every
   Appearance font (section 6). Mini apps should read the same set.
6. **A new `presenter` specialist** owns the workspace, with a `present`
   tool group (create, update, read, render to PNG). Draftsman keeps
   charts and diagrams inside pages. One routing line sends every other
   "draw / show / animate / schematic / slides" ask to Presenter.
7. **The browser sidecar that already exists** (browserless Chromium,
   driven by `puppeteer-core`) renders the poster after each save and hands
   the agent a PNG plus console errors, so it sees and fixes its own work.

## 2. Jason's question: what do we already ship?

Short answer: **nothing an agent can use inside a sandbox today.** We ship
several graphics libraries, but they are bundled into the owner UI as React
components, or run server side. The mini-app sandbox allows only React,
react-dom, lucide-react and our small UI kit.

| Library                                                                                               | Where                                                       | What it does today                                                                                                                              | Agent-usable in a no-network iframe?                                                     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@excalidraw/excalidraw` 0.18.1                                                                       | `server/web/package.json`, client `client/web/package.json` | The `draw` editor (`client/web/components/draw/excalidraw-canvas.tsx`); server re-render via the sidecar ([docs/draw.md](../draw.md) section 4) | No. A full editor app. Agents only read drawings (`draw-read`: `draw_list`, `draw_get`)  |
| `katex` 0.19 / 0.18                                                                                   | `server/web`, `packages/share-ui`, client `client/web`      | Page maths, formulas                                                                                                                            | CSS only: app frames load `/share-runtime/katex/katex.min.css`; the JS is not importable |
| `recharts` 3.x                                                                                        | client `client/web`, `packages/web-ui` (`src/ui/chart.tsx`) | Dashboard charts                                                                                                                                | No. Owner UI only                                                                        |
| `@xyflow/react` 12 + `dagre`                                                                          | client `client/web`                                         | Studio graph, recall graph, trace view                                                                                                          | No. Owner UI only                                                                        |
| `thinking-orbs`, `@firecms/neat` (WebGL), hand-written WebGL in `packages/web-ui/src/drift/engine.ts` | client, share-ui                                            | Loader orb, backdrops                                                                                                                           | No. Decorative UI                                                                        |
| `@resvg/resvg-wasm` 2.6.2                                                                             | `packages/content` (`draw-png-render.ts`)                   | Server SVG to PNG                                                                                                                               | Server side only                                                                         |
| `puppeteer-core` + `ghcr.io/browserless/chromium:v2.57.0`                                             | `server/web`, `docker-compose.yml` service `browser`        | PDF export, draw re-render, draw PNG (`server/web/lib/render-pdf.ts`, `render-draw-png.ts`, `render-sandbox.ts`)                                | Server side; the base for `present_render`                                               |
| `esbuild`                                                                                             | `server/web`, `packages/app-build`                          | Bundles mini apps                                                                                                                               | Build tool                                                                               |

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
  animation and covers 27 fixed types. A P&ID or process schematic is not
  one of them. Its routing line says "every diagram or chart destined for a
  page", so a chat ask for a picture has no clear owner. That is the gap the
  owner assistant fell into when asked for a P&ID-style drawing.
- **Mini apps** (Appsmith): real React, but the bundler allowlist is
  `react`, `react-dom`, `lucide-react` plus the kit
  (`packages/app-build/src/index.ts` line 66 and line 155). No chart or
  animation library. An app also carries a database and a tool bridge, more
  machinery than a drawing needs.
- **`generate_image`**: raster from an image model. Not editable, not exact.

## 3. What a canvas is, and what it deliberately is NOT

|                      | Draftsman SVG   | Draw (Excalidraw) | Mini app                  | **Present canvas**                              |
| -------------------- | --------------- | ----------------- | ------------------------- | ----------------------------------------------- |
| Author               | agent           | human             | agent (Appsmith)          | agent (Presenter); a human edits text or source |
| Format               | static SVG file | JSON scene        | TSX tree, built bundle    | one HTML document                               |
| Scripts / animation  | no              | no                | yes                       | **yes**                                         |
| Libraries            | none            | n/a               | React + kit only          | vendored set (section 6)                        |
| Database             | no              | no                | per-app SQLite            | **no**                                          |
| Tool calls / network | no              | no                | declared tools via bridge | **no**                                          |
| Build step           | no              | no                | esbuild                   | **none the agent sees**                         |
| Draft / commit       | via its page    | yes               | draft, build, publish     | **no: latest is live**                          |
| Lives in             | Files + a page  | Draw workspace    | Apps workspace            | **Present workspace**                           |

A canvas never gets a database, a tool bridge, secrets, network, or a build
step of its own. If it needs live data or saved input, it is a mini app,
and Presenter says so. Data a canvas shows is baked in when the agent
writes it (read first with the agent's normal read tools).

## 4. The Present workspace

### 4.1 Model: copy Draw

Draw is a `nodes` row of `type='draw'` with a 1:1 `draws` sidecar
(`packages/db/src/schema/draws.ts`; [docs/draw.md](../draw.md) section 2):
the scene, derived text for search, an SVG snapshot that is a cache, an
etag. Present mirrors it:

```
nodes.type = 'present'            (name to confirm, open question 6)
presents
  node_id      uuid PK, FK nodes ON DELETE CASCADE
  source       text   the HTML document (source of truth), max 1 MB
  source_text  text   derived: title, description, visible text (search, extract)
  meta         jsonb  { size: '1600x900' | 'fill', theme, libs: [...], slides: n }
  css          text   Tailwind compiled from the source on save (section 6.3)
  poster_png   bytea or a file ref: the snapshot (a CACHE, never the source)
  poster_rev   int    the rev the poster was made from (staleness marker)
  rev          int    optimistic-concurrency etag (as draws.draft_rev)
```

- **Folders:** the shared row-only kind folders (`tree_folders`,
  `tree_folder_create`, `tree_item_move`, as Draw and Apps use).
- **Workspaces, grants, delete and cleanup, backup:** as for `draw` rows.
- **No draft, no commit.** `rev` guards against two writers at once; it is
  not a review step.
- **Revisions:** keep the last 10 `source` versions in a small side table,
  so a bad agent rewrite can be undone (open question 4). Shares still
  always show the latest.

### 4.2 The canvas document

A tiny required head, so tools and the UI can read it without running it:

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
    <!-- design size, or "fill" for a responsive layout (section 7.1) -->
  </head>
  <body>
    ...
    <script type="module">
      import * as d3 from 'd3'; // a bare name from the vendored set (section 6.2)
      // ...
    </script>
  </body>
</html>
```

Optional heads: `canvas:theme="fixed"` (ignore the owner's theme),
`canvas:poster-at="2.5s"` (when to take the poster of an animation).
Images go in as `data:` URLs or SVG in v1, because the frame cannot fetch.
(Later: the frame route may inline brain images by id at serve time.)

### 4.3 Indexing, without runaway cost

`source_text` is our own pure walker (title, description, visible text,
`<script>` and `<style>` removed), like Draw's `scene-to-text`. Search and
the extractor read it.

Careful: with no commit step, an agent may save ten times in a minute.
Draw fires one `node_ingested` per commit; Present must not fire one per
save, or one canvas causes ten LLM passes (the cost-safety rule: no trigger
that can cause runaway LLM runs). So: fire `node_ingested` only when
`source_text` actually changed, and at most once per item per quiet period
(for example after 5 minutes without a save). A colour change then costs
nothing.

### 4.4 The `.canvas` file format: export and import only

`.canvas` stays the portable form: the same HTML in one text file.

- **Export:** "Download" on a Present item writes `<name>.canvas`.
- **Import:** uploading a `.canvas` in /files offers "Open in Present",
  which makes a Present item from it.
- A `.canvas` sitting in /files does **not** run there; it shows as source
  text. One live surface, not two.
- The raw file route keeps treating it as a download
  (`safeDownloadHeaders` forces HTML to `attachment`, section 5.1).

Why not a folder bundle: the files model has no folder-as-one-file idea
(nearest is the `.mantleapp` zip export), and adding one touches the tree,
shares, backup and the disk watcher. If multi-file is ever needed, store a
virtual tree `{ entry, files }` in the sidecar, as mini apps do in
`apps.source` (`packages/content/src/apps.ts`). A zip is fine as an export
format, not as the working format: agents cannot patch a zip with text
tools.

## 5. Security

### 5.1 What the stack does today (evidence)

- **Raw file bytes:** `safeDownloadHeaders`
  (`packages/client-types/src/lib/safe-download.ts`) always sends `nosniff`,
  serves only an allowlist inline, and forces `text/html` to
  `application/octet-stream` + `attachment`. **Uploaded HTML is never
  rendered today.**
- **Mini apps:** iframe `sandbox="allow-scripts"`, no `allow-same-origin`
  (share-ui `app-sandbox.tsx` line 496), `src` to a ticketed
  `/api/apps/<id>/frame` route on the brain origin, header CSP from
  `buildAppFrameCsp` (share-ui `app-frame-html.ts`):
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' <origin>/app-runtime/ <origin>/share-runtime/; ... connect-src 'none'; base-uri 'none'; form-action 'none'`.
  The only channel out is the postMessage bridge.
- **Email HTML:** sanitised on the brain (`packages/email`, `sanitize-html`),
  shown in a `srcDoc` iframe with no scripts (client
  `client/web/components/reading-pane.tsx`).
- **The sidecar:** loads only our own render routes, with a render cookie,
  and aborts every other request (`server/web/lib/render-sandbox.ts`;
  [docs/security.md](../security.md) section 2).

### 5.2 How to run a canvas safely

Reuse the app frame plumbing, minus the bridge:

- iframe `sandbox="allow-scripts"` only. Never `allow-same-origin`,
  `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`.
- `src` to a ticketed frame route: `/api/presents/<id>/frame?t=...`, and
  `/s/<token>/frame?t=...` for shares. Never `srcdoc` from the parent.
- Header CSP:
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <origin>/canvas-runtime/; style-src 'unsafe-inline' <origin>/canvas-runtime/ <origin>/share-runtime/; img-src data: blob:; font-src data: <origin>/canvas-runtime/ <origin>/share-runtime/ <origin>/fonts/ <origin>/Inter/; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors <owner UI origins>`.
  Unlike apps, `img-src` does **not** include the brain origin, so a canvas
  cannot even fire GETs at our own API. `'unsafe-eval'` is for Alpine.js
  (section 6.1).
- Messages: the parent accepts `ready` and `error` from its own iframe
  (`e.source` checked, as apps do) and sends `theme`. The text-edit mode
  (section 9.3) adds one message, owner view only. Nothing else.
- Posters everywhere else mean no live frames in pages or chat, so a busy
  page never runs ten canvases at once.

### 5.3 Risks that remain

- **CPU and memory abuse.** A buggy or hostile canvas can spin a core. The
  sandbox does not stop that. Only the item view and a share run it, one at
  a time; the sidecar render has a timeout.
- **Fake UI / phishing inside the frame.** A canvas can draw a fake login
  box. It cannot send what is typed anywhere (`connect-src`, `form-action`,
  no popups, no top navigation). On shares, a host pill labels the page as
  a shared canvas.
- **Prompt injection into the author.** A document the agent read can steer
  what it writes. The sandbox keeps the result inert (no network, no bridge,
  no cookies). The worst case is misleading content, as on a page today.
- **Private data baked in.** A canvas carries whatever data the agent put in
  it. Sharing is the same explicit act as for any item; workspace rules
  apply.
- **Public shares (decided 2026-10-23: the live canvas, full screen, always
  the latest save).** Agent-written script runs for anonymous visitors on
  the brain's domain, so the share path holds these rules:
  - the same frame CSP and `sandbox`, with a short-lived ticket, exactly
    like a shared app frame;
  - no server work from a public view: the public path never starts a
    Chromium render (the Draw rule, [docs/draw.md](../draw.md) section 4);
    link previews use the poster cache only;
  - a rate limit on the frame route (`RATE_LIMITS` + `ROUTE_GATES`);
  - the host pill;
  - closing the link, or deleting the item, stops it at once.

## 6. Libraries, CSS and fonts

### 6.1 The set: one library per job (revised 2026-10-23 with Jason)

Vendored, pinned, offline, served by the brain from `/canvas-runtime/`.
No CDNs: some boxes block egress, a CDN would widen the CSP to third-party
script hosts, every view would ping a third party, and versions would
drift. Sizes are rough, minified; a library loads only when a canvas
imports it.

| Category                      | Library        | What it is for                                                                               | Size       | Licence                                                    |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| Charts and dashboards         | Apache ECharts | Large chart catalogue, interactive, gauges, Sankey, heatmaps; Canvas or SVG output           | ~1 MB      | Apache-2.0                                                 |
| Engineering and science plots | Plotly.js      | Contour, heatmap, 3D surface, statistics, WebGL scatter for very large data                  | ~3 to 4 MB | MIT                                                        |
| Custom drawing, schematics    | D3             | Scales, layouts, force graphs, maps, full control of the SVG                                 | ~280 KB    | ISC                                                        |
| Interactive 2D                | Konva          | Shapes people can drag, click and connect                                                    | ~150 KB    | MIT                                                        |
| 3D                            | Three.js       | WebGL scenes: plant layouts, equipment models                                                | ~650 KB    | MIT                                                        |
| Animation                     | Motion         | Transitions and movement; has a React API too, for mini apps                                 | ~40 KB     | MIT                                                        |
| Slides                        | reveal.js      | Decks: one `<section>` per slide, keyboard and touch navigation, print layout                | ~150 KB    | MIT                                                        |
| Maths                         | KaTeX          | Formulas (already shipped in `share-ui`)                                                     | ~280 KB    | MIT                                                        |
| Interactive state             | Alpine.js      | Tabs, toggles, sliders, step-through explainers, chart filters, as HTML attributes. Optional | ~45 KB     | MIT                                                        |
| Custom vector drawing         | plain SVG + JS | No library. The default choice                                                               | 0          | n/a                                                        |
| Timeline animation (maybe)    | GSAP           | The strongest timeline tool. Add only if its licence fits                                    | ~70 KB     | Free "no charge" licence, NOT OSI open source: check first |

Alpine's normal build evaluates attribute expressions with `new Function`,
so the CSP carries `'unsafe-eval'`. In this frame that adds almost nothing:
the frame already runs agent-written script, and the boundary that matters
(no network, no bridge, opaque origin) is unchanged. The stricter
`@alpinejs/csp` build avoids eval but supports fewer expressions; use it if
the audit prefers.

Considered and left out:

| Library         | Why not                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Chart.js        | ECharts covers it                                                                                                                        |
| anime.js        | Motion covers it                                                                                                                         |
| lottie-web      | Plays designer-made After Effects files; agents cannot author them well                                                                  |
| PixiJS          | Games and particles; Konva and Three cover our needs                                                                                     |
| Mermaid         | Removed on purpose in 2026-08 for weak output ([docs/diagrams.md](../diagrams.md)); competes with Draftsman                              |
| Slidev          | Needs a Node/Vite build                                                                                                                  |
| Leaflet (later) | Map tiles come from the internet, which the sandbox blocks. Without a tile source the brain serves, only GeoJSON shapes with no base map |

Adding a library is a normal release change: pinned version, a line in
`THIRD-PARTY-NOTICES.md`.

**Mini apps have the same gap** (allowlist `react`, `react-dom`,
`lucide-react`, `packages/app-build/src/index.ts` line 66). Build ONE
vendored runtime and one import map that canvases and mini apps both read.
That is a separate change on its own branch, best landed before or with
Present P1.

### 6.2 How loading works: the agent configures nothing

- **Every canvas frame carries the same import map** listing the whole set.
  It is only an address book: the browser fetches a library **only when the
  canvas imports it**, then caches it.
- **The agent just writes the import** (`import * as echarts from 'echarts'`,
  `import Alpine from 'alpinejs'`). No list, no config, no versions.
  Libraries with only a classic browser build (Plotly) load with
  `<script src="/canvas-runtime/plotly/plotly.min.js">`; the skill gives
  the exact line.
- **The save tool checks it, like `app_build` does.** An unknown name or a
  CDN URL fails the call with the allowed list, so the agent fixes it before
  anyone sees a blank canvas. The names found go into `meta.libs`.
- **Always present, because small or lazy:** the theme stylesheet, the
  compiled Tailwind, the kit CSS, and the `@font-face` rules.
- **Versions are the brain's.** The import map points at the version a
  release ships; release notes list which canvases import an upgraded
  library, so `present_render` can check them first.

### 6.3 CSS and the shadcn look

What mini apps get today, reused:

- `/share-runtime/styles.css`: base styles and the colour tokens of every
  theme, generated from `packages/share-ui/styles/themes.css`
  (`pnpm themes:build`). The host posts the active theme into the frame.
- A server-side Tailwind compile (`packages/app-build/src/css.ts`, the
  `tailwindcss` `compile` API) that emits only the utilities used, mapped
  onto the shadcn tokens (`bg-card`, `text-muted-foreground`,
  `border-border`, `chart-1..5`).
- Six shadcn components as React (`packages/app-build/src/kit.ts`).

For a canvas (plain HTML, no React):

1. **Tokens:** the frame links `/share-runtime/styles.css` and takes the
   theme message. `var(--primary)`, `var(--card)` and the rest just work.
2. **Tailwind, compiled on save:** the save tool runs the same `css.ts`
   compile over the source and stores it in `presents.css`. The agent writes
   `class="rounded-lg bg-card p-6 text-foreground"`. No CDN, no in-browser
   Tailwind.
3. **shadcn look without React:** a small `mantle-kit.css` with plain
   classes (`.btn`, `.btn-outline`, `.card`, `.badge`, `.input`), generated
   from the SAME class strings in `kit.ts`, so it cannot drift from the
   apps. (Basecoat, MIT, does this for plain HTML; our own file is smaller
   and tied to our tokens.)
4. **Theme on or off:** a canvas follows the theme by default;
   `canvas:theme="fixed"` pins the light palette.

Mini apps already have 1 and 2, and would gain more kit components (tabs,
table, select, dialog, tooltip) in the mini-app change.

### 6.4 Fonts: every Appearance font

- One registry, `packages/client-types/src/display-fonts.ts`, drives
  Settings → Appearance: 16 faces (Inter plus 15 library faces across sans,
  serif, mono and display), all variable fonts.
- The files are on the brain: `server/web/public/fonts/library/` (22 woff2
  plus `licenses/`) and `server/web/public/Inter/`, served at `/fonts/*` and
  `/Inter/*` (`server/web/server/static.ts` line 52).
- `displayFontFaceCss()` builds the `@font-face` block the share and print
  shells already inject.

The frame route injects that block plus Inter, and sets `--font-sans`,
`--font-serif`, `--font-mono` and the prose font to the owner's choices. A
canvas uses `var(--font-sans)` or names any face (`"Fraunces"`). Files load
only when text uses them. The `canvas_authoring` skill lists the 16 names,
generated from the registry. Posters use the same fonts, because the
sidecar loads the brain's own origin (Draftsman SVG cannot: it shows
through `<img>`, system fonts only).

## 7. Where a canvas shows

### 7.1 The Present view (live)

`/present` lists items with their posters. `/present/<id>` runs the canvas
live, scripts and animation going. Header actions on the standard item
header (`client/web/components/layout/item-header.tsx`):

- **Maximise**: the existing `FocusToggle`
  (`client/web/components/layout/focus-toggle.tsx`), same slot and icon as
  every kind; hides the shell and folders, Esc leaves.
- **Full screen**: the browser Fullscreen API on the frame only, for
  presenting. Esc leaves. For a deck, arrow keys and swipes move slides.
- **Replay**: reloads the frame, so an animation starts again.
- **Edit text**: section 9.3.
- **Source**: the HTML in a text view (edit for those who may edit).
- **Share**, **Download `.canvas`**, **Assist** (Presenter, as Appsmith backs
  the Apps Assist panel).

Fit: `canvas:size="1600x900"` scales the design to the space with
letterboxing, so it looks the same at every size; `canvas:size="fill"`
gives the canvas the whole viewport, as a mini app gets. The phone app uses
the same frame route.

### 7.2 Share links (live, full screen)

Copy the shared-app layout that exists: `/s/<token>` skips the share shell
and renders the frame at `h-dvh` with a small floating pill
(`server/web/server/pages/share.tsx`, the `app` case, around lines 219 and
269). The pill carries the full-screen button and the "shared canvas"
label. Public, contact and login shares use the same view. Rules: section
5.3.

### 7.3 Everywhere else: the poster, which opens the real thing

No live embeds (Jason, 2026-10-23). The poster PNG stands in, and a click
opens `/present/<id>` (or, on a shared page, the canvas's own share if it
has one).

- **Pages:** `![title](present:<id>)`, mirroring `draw:<id>` (client
  `page-editor/image.ts`): an `<img>` of the poster, wrapped in a link to
  the item. Human-writable markdown, per the Pages dialect principle.
  Editing the canvas updates the poster, so every page shows the latest.
  A deck may embed one slide: `![title](present:<id>#3)` (later).
- **Chat:** `show_present` returns `{ kind: 'present', id }`;
  `ArtifactView` (client `assistant/assistant-turn-parts.tsx` line 82) shows
  the poster card with an Open button. Telegram and the phone get the PNG
  and a link; voice says the title.
- **PDF, DOCX, email, page shares:** the poster, as drawings use their
  snapshot. A shared page serves only the posters its doc places, like
  `referencedDrawIds`.

### 7.4 The poster

- Made by the sidecar after a save (debounced), at the design size, at
  `canvas:poster-at` for animations (default: after 2 s), slide 1 for
  decks. Stored in `presents.poster_png` with `poster_rev`.
- A cache, never the source. Rules copied from Draw: only owner paths fill
  it; filling never fires `node_ingested`; 2 concurrent renders; timeout and
  cooldown on failure; public routes are cache-only.
- No sidecar on the box (it is profile-gated in `docker-compose.core.yml`):
  pages and chat show a title card with Open instead of a picture, and the
  agent works blind. Open question 7.

## 8. The Presenter agent

### 8.1 Where it lives

All in the system manifest (`server/web/lib/system-manifest/`), so new and
existing brains get it through the normal reconcile:

- `MANIFEST_AGENTS`: slug `presenter`, `role: 'custom'`, `isDelegate: true`,
  `envModelVar: 'PRESENTER_MODEL'`,
  `toolGroupSlugs: ['present', 'files', 'memory-core']`,
  `skillSlugs: ['canvas_authoring', 'writing_style']`,
  `params: { temperature: 0.3, max_tokens: 32000 }` (like Draftsman),
  `memoryConfig: { max_iterations: 25 }`.
- `MANIFEST_SKILLS` + `SKILL_INSTRUCTIONS['canvas_authoring']`: the head
  contract, size and fit, theme tokens and kit classes, the 16 fonts,
  reduced motion, the library list with one example each, no network, the
  deck template (section 9.2), and how to look at the render and fix it.
- `MANIFEST_TOOL_GROUPS`: `present` (authoring), `present-read` (list, get,
  show) for the persona, and deletes in a `present-admin` group, as other
  kinds keep deletes deliberate.
- `AGENT_PROMPTS['presenter']`.

### 8.2 Tools

| Tool                                    | What it does                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `present_create`                        | Make an item in a folder, validate the head and imports, compile CSS, queue the poster; return id and view URL                    |
| `present_update`                        | Replace the source, or apply exact find-and-replace edits so the agent does not resend 50 KB for a colour change. Takes `if_rev`  |
| `present_get` / `present_list`          | Source plus meta / the items                                                                                                      |
| `present_render`                        | Render in the sidecar at a size and time (or a slide); return a PNG the model can see plus console errors and uncaught exceptions |
| `show_present`                          | The poster card in chat (section 7.3)                                                                                             |
| `present_import` / `present_export`     | `.canvas` file to item, item to `.canvas` file                                                                                    |
| `present_revisions` / `present_restore` | The last 10 versions (if approved)                                                                                                |

### 8.3 Routing, so the owner assistant stops struggling

Edit `specialist_routing` (prompts.ts line 406):

- **Draftsman**: a chart or diagram that lives in a page, with a spec block.
- **Presenter**: every other picture to look at: process and P&ID style
  schematics, animated or interactive explainers, slide decks, posters,
  "draw me", "show me how X works". The result lands in Present and comes
  back to chat as a poster that opens it.
- **Appsmith**: only when it needs live data, saved input, or tools.

Also add Presenter to `visual_answers`, and two cases (a P&ID ask, a deck
ask) to `eval:route`, so the routing is measured. Open question 2 asks
whether Draftsman later folds into Presenter.

## 9. Slides: Present takes its place

### 9.1 What the parked plan was

The Slides plan (branches only, never merged) is a PowerPoint-style editor:
a structured JSON deck on a 1920x1080 stage, named regions on a 12x6 grid,
our own drag, resize, rotate and snap layer, smallest text 24 units,
Reveal.js 6 as the player, and a `slide_render` PNG through the sidecar.
Most of its cost and risk is the hands-on editing layer.

### 9.2 Decks in Present

A deck is a canvas that uses reveal.js, one `<section>` per slide. From the
Slides plan, keep what is cheap and proven as a deck template in the
`canvas_authoring` skill: the 1920x1080 stage, the 12x6 grid as CSS
classes, the 24-unit smallest text, reveal.js as the player, and the agent
checking its own render slide by slide. Slides get animation, charts and 3D
everywhere, which the JSON model only had inside embedded elements.

### 9.3 Hands-on editing, small first

Most hand edits are a typo, a number or a title. A canvas marks editable
text with `data-edit="<id>"`. In **Edit text** mode the host tells the frame
to make those elements editable; on save the frame posts the new text, and
the server patches only those elements in `source`. Text only, owner view
only, never on a share.

Drag-and-drop layout editing stays out until real use shows people need
it. If it comes, it is a mode inside Present, not a second workspace, and
the parked Slides branches are the place to take it from.

### 9.4 Export

PDF through the sidecar (reveal.js has a print layout, like `/print/pages`
today). PPTX from HTML is poor in every tool; if PPTX is a must, that is the
one strong reason to bring back the structured deck model (open question
8).

## 10. Open questions for Jason

1. ~~One file or a bundle?~~ Settled by the workspace: one HTML document per
   item in the sidecar; `.canvas` is the export and import file.
2. **Presenter beside Draftsman, or one visual specialist?** My pick:
   Presenter now, the one-line routing rule, decide on a merge after the
   eval numbers.
3. ~~Public shares?~~ **Decided 2026-10-23:** live, full screen, always the
   latest save.
4. **Revisions:** keep the last 10 versions for undo, or none?
5. **Library set:** approve section 6.1. Is GSAP's licence fine for a
   public, commercially licensed repo, or is Motion enough?
6. **Names:** the workspace "Present", the agent "Presenter", the node type
   `present`, the item a "canvas"? All placeholders.
7. **The sidecar:** it is optional in `docker-compose.core.yml`. Make it
   required when Present is on, or accept title cards and blind authoring?
8. **Slides branches:** retire them now (Present replaces them), or keep
   them parked as the source for a later layout editor? Is PPTX export a
   must?

## 11. Phased plan (rough sizes, one developer)

| Phase               | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Repo  | Size         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| P0 Spike            | A hand-written canvas in a throwaway table; frame route with the CSP; open it in the client. Prove sandbox, theme message, import map, fonts                                                                                                                                                                                                                                                                                                                                                                                                       | both  | 2 days       |
| P1 Workspace        | `present` node type + `presents` sidecar (migration); routes (list, get, create, update, delete, frame); folders, workspace grants, delete and cleanup, backup, search kind; `/canvas-runtime/` with the set and import map; CSS compile on save; extractor with the quiet-period ingest; client: nav entry, `/present` list, `/present/<id>` live view with Maximise, Full screen, Replay, Source; contract bump. New node type: the client-types publish and the client pin bump land in the same release, or the client's node-type icons break | both  | 8 to 10 days |
| P2 Agent and poster | Sidecar render route, `present_render` with console capture, the poster cache; `present`, `present-read`, `present-admin` groups and tools; `presenter` agent, `canvas_authoring` skill, routing edits; `eval:route` cases                                                                                                                                                                                                                                                                                                                         | brain | 5 to 6 days  |
| P3 Reach            | Poster embeds: `present:` in pages, `show_present` in chat, PDF, DOCX, email, page shares; share links full screen with pill and rate limit; `.canvas` export and import                                                                                                                                                                                                                                                                                                                                                                           | both  | 4 to 5 days  |
| P4 Decks            | Deck template in the skill; PDF export of a deck; Edit text mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | both  | 3 to 5 days  |
| Later               | Revisions UI; slide-level embeds; drag-and-drop layout mode if needed; brain images inside canvases                                                                                                                                                                                                                                                                                                                                                                                                                                                | both  | per item     |

The vendored library runtime shared with mini apps is its own change and
should land before or with P1.

Each phase lands with an independent read-only security audit on a fixed
commit, since this is the first feature that runs agent-written script in
front of people.
