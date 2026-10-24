# Diagram guides

Per-type drawing references for the **Draftsman** diagram specialist (agent slug
`diagrammer`, skill `diagram_design`, see [`../diagrams.md`](../diagrams.md)).
Agents read them through two tools, `diagram_types` and `diagram_guide`
(`packages/tools/src/builtins-diagrams.ts`), straight from these files. Nothing
indexes them; nothing has to be enabled.

## What is here

- `type-*.md`: one file per visual type (45 types), plus the shared references
  (`style-guide.md`, `layout-budget.md`, `primitives-core.md`, `output-spec.md`,
  `semantic-patterns.md`), the optional primitives (`primitive-*.md`) and the
  three import guides (Mermaid, draw.io, Excalidraw). Vendored verbatim from the
  MIT-licensed
  [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design)
  project (`skills/diagram-design/references/`), **v2.6.119, upstream commit
  `7a12007`** (2026-10-21). Copyright the diagram-design contributors; MIT
  license. Kept verbatim so upstream updates can be re-copied.
- `mantle/`: Mantle's own files, never overwritten by a refresh.
  `medium.md` holds the medium rules every `diagram_guide` reply starts with
  (static SVG, system font stacks, no tooling); `type-pid.md` is the P&ID and
  process-schematic type (first draft); `type-flow.md` the process flow. Both
  have a layout template (`packages/diagram-templates`): their guide's
  default is the template's data contract.

Site conventions do NOT belong here: each brain keeps its own in
`files/diagrams/profiles/<type>.md`, which `diagram_guide` appends after the
base guide (see "Site profiles" in [`../diagrams.md`](../diagrams.md)).

## Not vendored

A guide that only works by running upstream tooling, or that contradicts the
static-SVG medium, stays out:

- `animation.md`: motion in the output. Mantle diagrams are static SVG.
- `export.md`, `export-registry.md`: export scripts and their JSON sidecar.
- `onboarding.md`, `profiles.md`: skin onboarding by editing the installed
  `style-guide.md`, and a profile library in the home directory. Mantle carries
  its own branding.
- `doctor.md`: diagnostics for the local python install and scripts.
- Five logos of `primitive-icons.md` (`hop`, `pentaho`, `dagster`, `sas`,
  `stata`): upstream fetched them from vendor sites and marks each "verify
  license before use". This repo is public, so they are left out until a
  licence is known. Every other icon names its MIT or CC0 source.

## Upstream aspects Mantle overrides

The `mantle/medium.md` rules come first in every reply and win:

- **Repo tooling.** Mentions of `scripts/*.py`, `template*.html` and `assets/`
  refer to the upstream repo. The Mantle agent has no shell and no template
  files; it draws from the rules alone.
- **Web fonts and the HTML wrapper.** Upstream writes an HTML page with Google
  fonts. Mantle diagrams are standalone SVG files rendered through `<img>`,
  where external fetches are blocked, so the medium rules map each font role to
  a system font stack.

The refresh procedure and how to add a Mantle type: [`../diagrams.md`](../diagrams.md).
