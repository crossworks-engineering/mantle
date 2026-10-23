# Diagrams: the Draftsman specialist

> Diagrams and charts, drawn as hand-authored SVG into a page, beside a small
> readable spec block. Agent slug `diagrammer` (display name "Draftsman"),
> skill `diagram_design`, tool group `diagram` (`diagram_types`,
> `diagram_guide`). This is the ONE diagram path: the Mermaid engine was
> retired in the same release cycle (2026-08).

## Why

Mermaid renders were structurally correct but visually underwhelming, and the
render was out of our hands, so it was removed outright. The Draftsman flips
the trade: the model draws the SVG itself, following an opinionated editorial
design system (vendored from the MIT-licensed
[diagram-design](https://github.com/cathrynlavery/diagram-design) project), so
layout, palette, and typography are deliberate. The cost is that raw SVG is
unreadable as source, which the spec block repairs (below).

## What happened to Mermaid

Removed end to end: agents are no longer taught it, page tools no longer lint
it, a ```mermaid fence parses as a plain code block, and the renderer + npm
dependency are gone from both repos. Stored docs keep their legacy `diagram`
nodes; every surface (editor, /s shares, print/PDF, docx, email) renders them
as a labelled source block, and editing one degrades it to an ordinary code
block. No data is lost; nothing draws them anymore. Ask the Draftsman to
redraw the ones worth keeping. (Excalidraw's own mermaid-paste converter
remains as a transitive dependency of the Draw feature; that is Excalidraw's
internals, not this engine.)

## The page contract: spec block + image

Every diagram in a page is two adjacent blocks:

1. A fenced code block with language `diagram`: small, free-form YAML naming
   the type, title, and content (nodes + edges, or series + data). This is the
   human- and agent-readable SOURCE, in keeping with the Pages dialect
   principle (every element legible as markdown).
2. `![<title>](media:<file-id>)`: the rendered SVG, uploaded under
   `files/diagrams/` via `file_create` and embedded like any page image.

Edits go spec-first: the agent updates the spec block, redraws, and overwrites
the same file. `upsertFile` keeps the node id on overwrite, so the `media:`
embed never breaks. SVG files are served through `safeDownloadHeaders` with the
sandboxing CSP, and render through `<img>`, where scripts and external fetches
are inert; the skill therefore mandates fully self-contained static SVG with
system font stacks.

## The pieces

| Piece                  | Where                                        | What                                                                                                                                          |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent `diagrammer`     | `server/web/lib/system-manifest/manifest.ts` | Delegate specialist; groups `diagram` + `pages` + `files` + `memory-core`; skills `diagram_design`, `page_editing`, `writing_style`           |
| Skill `diagram_design` | `server/web/lib/system-manifest/prompts.ts`  | The page contract, the medium rules, the workflow (`diagram_types`, then `diagram_guide`, then draw), the connector rules and the final check |
| Tool group `diagram`   | `packages/tools/src/builtins-diagrams.ts`    | `diagram_types` + `diagram_guide`: read-only, no model call, no database; also on the MCP surface                                             |
| Vendored guides        | `docs/diagram-guides/`                       | Upstream's per-type references and shared rules, verbatim                                                                                     |
| Mantle's own guides    | `docs/diagram-guides/mantle/`                | The medium rules (`medium.md`) and Mantle's own types (`type-pid.md`)                                                                         |
| Routing                | `specialist_routing` + `rich_writing` skills | The main assistant hands ALL diagram + chart work to the Draftsman; no agent hand-writes diagram source                                       |

## The guide tools

The full design system is about 800KB of markdown and cannot ride in a
prompt. The skill carries the contract and the core rules; the rest is two
tools that read the guide files baked into the image (`MANTLE_DOCS_ROOT`,
`/app/docs` in production) straight from disk:

- **`diagram_types()`** lists every type with a one-line "use when", the
  semantic patterns (behaviour-first routing: pick one pattern, then the
  nearest type), and the import notations (mermaid, drawio, excalidraw).
- **`diagram_guide(type, pattern?, import?, shared?)`** returns, in order:
  the Mantle medium rules (`mantle/medium.md`), the style guide, the layout
  budget, the core SVG primitives, the output sizes, then the type's own
  guide. `pattern` adds that one semantic pattern; `import` adds the import
  guide and the fidelity ledger; `shared: false` skips the shared rules for a
  second type in the same task. An unknown type is an error that names every
  valid type.

Sections that only make sense for upstream's HTML-in-a-repo medium are cut
from the reply (the HTML page layout, summary cards, export formats, the
narrow-screen scroller, non-Latin font notes, skin customising, each type's
list of example HTML files). The rest goes through verbatim, and the medium
rules come first and win.

Sizes: the shared rules are about 32KB; a whole reply is 33KB to 75KB (the
line chart, the largest type guide, is the top). `builtins-diagrams.test.ts`
fails past 80KB, so a refresh that grows a guide is a decision.

Nothing has to be enabled or indexed. Until 2026-10-23 the guides were the
opt-in `diagram-guides` docs collection, reached through `search_chunks` and
`read_section`; most brains never enabled it, and the Draftsman burned its
rounds searching for guides that were not there. A fresh brain no longer gets
that collection row. A row an existing brain already has stays: disabled it
is inert, enabled it indexes the same files harmlessly (switch it off at
`/docs`).

## Site profiles

Every site draws differently, so a type's guide comes in two layers: the
base guide in the repo (generic, public) and a **site profile** in each brain
(the site's own conventions, which are client data and never enter the
repo).

- **Where:** one markdown file per type in the brain's Files,
  `files/diagrams/profiles/<type>.md` (ltree `files.diagrams.profiles`), for
  example `pid.md`. A fixed path, so nothing has to be configured, and it is
  an ordinary file the owner can open, edit or upload.
- **Read:** `diagram_guide` looks for the file in the caller's scope (like
  `file_list` / `file_read`), appends it after the type guide with a note that
  it wins, and reports `site_profile`: found, cut (past 20,000 characters), or
  "None" with how to start one.
- **Grown over time:** when the owner corrects a convention or shows a legend
  sheet, the Draftsman reads the profile, adds the convention under the
  matching heading, and saves the whole file back with `file_create`
  (`overwrite: true`). The P&ID guide's last section lists the suggested
  headings (symbols, service colours, line numbers, circuits, title block,
  tags). An owner can also write the file by hand.
- Any type can have a profile; the P&ID is the one that needs it first.

## Boundaries

- **No invented data.** Chart numbers come from the request, the page, or the
  brain; missing data is reported, not imagined. The same holds for P&ID
  tags, line numbers and set points.
- **Draft-only writes**, like every page specialist; the operator commits.
- **Static SVG only.** No animation (scripts cannot run in `<img>`), no
  external fonts or images; the medium rules map the guides' font roles to
  system font stacks.
- The theme does not reach inside a static SVG: diagrams ship the light
  editorial palette regardless of app theme, like any uploaded image.

## Refreshing the vendored guides

Upstream: [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design),
local clone `~/Projects/diagram-design`. Current copy: **v2.6.119, upstream
commit `7a12007`** (2026-10-21).

```sh
cd ~/Projects/diagram-design && git pull
SRC=skills/diagram-design/references
cp $SRC/type-*.md $SRC/primitive-*.md \
  $SRC/{semantic-patterns,style-guide,output-spec,layout-budget,primitives-core}.md \
  $SRC/{import-drawio,import-mermaid,import-excalidraw}.md \
  <mantle>/docs/diagram-guides/
```

Then:

1. A new `type-*.md` needs a row in `DIAGRAM_TYPES`
   (`packages/tools/src/builtins-diagrams.ts`) with its one-line "use when"
   from upstream's visual-type guide (SKILL.md section 3). The test fails
   until every type file has a row and every row a file.
2. Read the diff of `SKILL.md` for rules that belong in the `diagram_design`
   skill, and of the shared files for new HTML-only sections to add to the
   cut lists (`SHARED_PARTS`).
3. Record the new version and commit here and in
   `docs/diagram-guides/README.md`.
4. Run `pnpm exec vitest run packages/tools/src/builtins-diagrams.test.ts`.

Never copy into `docs/diagram-guides/mantle/`; that folder is Mantle's own.

Not vendored, on one rule: a guide that only works by running upstream
tooling, or that contradicts the static-SVG medium, stays out.

- `animation.md`: motion; scripts cannot run in `<img>`.
- `export.md`, `export-registry.md`: export scripts and their JSON sidecar.
- `onboarding.md`, `profiles.md`: skin onboarding by editing the installed
  `style-guide.md` and a profile library in the home directory. Mantle
  carries its own branding.
- `doctor.md`: diagnostics for the local python install and scripts.

The three import guides ARE vendored although their first step runs an
extractor script: the rest (mapping, dials, fidelity ledger) is the useful
part, and the medium rules tell the agent to read the source itself
(Mermaid text, a `.drawio` file, `draw_get` for an Excalidraw whiteboard).

## Adding a Mantle type

1. Write `docs/diagram-guides/mantle/type-<slug>.md` in the shape of the
   upstream guides: best for and not for, layout conventions, symbols, a
   complexity budget, anti-patterns, an example spec block. Name colours and
   fonts by role (`{ink}`, `{node-name}`), never by value. Generic examples
   only: the repo is public.
2. Add its row to `DIAGRAM_TYPES` with `origin: 'mantle'`, the file path,
   a "use when" line and any aliases callers will use.
3. Run the test above; the catalog and size checks cover it.

Mantle types so far:

| Type  | Guide                                                                                        | State                                                                    |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pid` | `docs/diagram-guides/mantle/type-pid.md` (base; site conventions go in each brain's profile) | First draft (2026-10-23), for review by a process or instrument engineer |
