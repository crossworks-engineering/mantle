# Diagram guides

Per-type drawing references for the **Draftsman** diagram specialist (agent slug
`diagrammer`, skill `diagram_design`, see [`../diagrams.md`](../diagrams.md)).
One file per visual type (38 types: `type-*.md`) plus the shared references
(semantic patterns, style guide, output sizes, optional primitives) and the two
import guides (Mermaid, draw.io).

These files are vendored from the MIT-licensed
[cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design)
project (`skills/diagram-design/references/`, v2.5.20), kept verbatim so upstream
updates can be re-copied. Copyright the diagram-design contributors; MIT license.

Four upstream references are deliberately NOT vendored, because each one works by
driving repo tooling this agent does not have. Skipping them is a decision, not an
oversight — reconsider only if the missing machinery is built:

- `animation.md` — motion in the output. Mantle diagrams are static SVG by
  contract (the skill forbids animation outright), so a guide explaining how to
  animate can only contradict it.
- `export.md` — converts a generated HTML file to `.svg`/`.png` via a script. The
  Draftsman emits SVG directly and has no shell.
- `onboarding.md` and `profiles.md` — extract a palette and typography from a
  website, then save named skins by **editing the installed `style-guide.md`**.
  These guides are read-only vendored docs here, and Mantle already carries its
  own branding (colour theme, the four display fonts, the uploaded logo). Worth
  revisiting as a real feature; not as a file the agent rewrites.

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
