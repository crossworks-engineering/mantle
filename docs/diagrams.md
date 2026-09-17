# Diagrams: the Draftsman specialist

> Diagrams and charts, drawn as hand-authored SVG into a page, beside a small
> readable spec block. Agent slug `diagrammer` (display name "Draftsman"),
> skill `diagram_design`, docs collection `diagram-guides`. This is the ONE
> diagram path — the Mermaid engine was retired in the same release cycle
> (2026-08).

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

| Piece                            | Where                                                 | What                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent `diagrammer`               | `server/web/lib/system-manifest/manifest.ts`          | Delegate specialist; groups `pages` + `files` + `memory-core`; skills `diagram_design`, `page_editing`, `writing_style`                         |
| Skill `diagram_design`           | `server/web/lib/system-manifest/prompts.ts`           | The condensed design system: contract, workflow, medium constraints, 27-type index, connector rules, 4px grid, complexity budget, a11y contract |
| Docs collection `diagram-guides` | `docs/diagram-guides/` + `packages/files/src/docs.ts` | The 27 per-type references + shared guides (semantic patterns, style guide, output sizes, primitives), vendored verbatim from upstream v2.3     |
| Routing                          | `specialist_routing` + `rich_writing` skills          | The main assistant hands ALL diagram + chart work to the Draftsman; no agent hand-writes diagram source                                         |

## Guide retrieval

The full design system is ~470KB and cannot ride in a prompt. The skill carries
the core rules (~9KB); the per-type references live in the `diagram-guides`
docs collection. Indexing is **opt-in** like every collection: enable it at
`/docs`. Once indexed, the agent runs `search_chunks` (branch `documentation`)
for the chosen type and pulls whole sections with `read_section` before
drawing. Unindexed, the skill says so and draws from its core rules alone, so
the agent still works out of the box, just with less per-type polish.

Upstream guide text mentions repo tooling (python verifiers, HTML templates).
The skill instructs the agent to ignore those: no shell, rules only.

## Boundaries

- **No invented data.** Chart numbers come from the request, the page, or the
  brain; missing data is reported, not imagined.
- **Draft-only writes**, like every page specialist; the operator commits.
- **Static SVG only.** No animation (scripts cannot run in `<img>`), no
  external fonts or images.
- The theme does not reach inside a static SVG: diagrams ship the default
  editorial palette (light paper) regardless of app theme, like any uploaded
  image.

## Refreshing the vendored guides

```sh
cd ~/Projects/diagram-design && git pull
cp skills/diagram-design/references/{type-*,semantic-patterns,style-guide,output-spec,primitive-*}.md \
  <mantle>/docs/diagram-guides/
```

Excluded on purpose: `animation.md` (JS playback cannot run in `<img>`),
`export.md` (browser export mechanics), `import-*.md` (call upstream python
scripts), `onboarding.md` (brand onboarding flow foreign to Mantle theming).
Re-enable-and-reconcile the collection after a refresh so the index follows.
