# Diagram guides

Per-type drawing references for the **Draftsman** diagram specialist (agent slug
`diagrammer`, skill `diagram_design`, see [`../diagrams.md`](../diagrams.md)).
One file per visual type (27 types: `type-*.md`) plus the shared references
(semantic patterns, style guide, output sizes, optional primitives).

These files are vendored from the MIT-licensed
[cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design)
project (`skills/diagram-design/references/`, v2.3), kept verbatim so upstream
updates can be re-copied. Copyright the diagram-design contributors; MIT license.

Two upstream aspects do NOT apply inside Mantle, and the `diagram_design` skill
overrides them:

- **Repo tooling.** Mentions of `scripts/*.py` checkers, `template*.html`
  variants, and `assets/` galleries refer to the upstream repo. The Mantle agent
  has no shell and no template files; it draws from the rules alone.
- **Web fonts.** Upstream loads Google fonts in an HTML wrapper. Mantle
  diagrams are standalone SVG files rendered through `<img>`, where external
  fetches are blocked, so the skill substitutes system font stacks.

This directory is a built-in docs collection (`diagram-guides`). Enable it at
`/docs` to index it into the brain; the Draftsman retrieves the right guide with
`search_chunks` (branch `documentation`) + `read_section` before drawing.
