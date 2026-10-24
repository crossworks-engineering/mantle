# Mantle medium rules

These rules come first and win over anything the guides below say. The guides
are written for an HTML file in a repository checkout; a Mantle diagram is one
standalone SVG file, stored in the brain and shown in a page through `<img>`.

## The output

- **One static, self-contained SVG.** No `<script>`, no animation, no external
  stylesheet, font `<link>`, image or `url(...)` to anywhere. Scripts and
  external fetches are dead inside `<img>`, so what you draw is exactly what
  renders.
- **No HTML wrapper.** Ignore everything about the page around the diagram:
  the eyebrow and `<h1>`, summary cards, the `overflow-x` scroller, the
  `min-width` rule, the dark and full-editorial variants, the template files
  of the upstream guides. The SVG is the whole deliverable. (Not the same
  thing as Mantle's layout templates, `flow` and `pid`: for those you write
  data and `diagram_render` draws it; see the type's template data.)
- **Size.** One root `<svg>` with a `viewBox` and matching `width` and
  `height` attributes; they set the intrinsic size in the page column. Pick
  the size preset as the shared rules describe (`doc-inline` by default).
- **Light skin only.** The app theme does not reach inside a static image, so
  every diagram uses the light column of the style guide.

## Fonts: system stacks only

Web fonts cannot load. Resolve the font roles of the guides to these stacks:

| Role in the guides                                            | font-family to emit                                  |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `{title}`, `{callout}` (Instrument Serif)                     | `Iowan Old Style, Palatino Linotype, Georgia, serif` |
| `{node-name}` (Geist sans)                                    | `system-ui, sans-serif`                              |
| `{sublabel}`, `{eyebrow}`, `{arrow-label}`, tags (Geist Mono) | `ui-monospace, Menlo, monospace`                     |

Keep the sizes, weights and the italic of `{callout}` from the guides.

## No tooling

You have no shell and no repository. Skip every instruction that runs a
script (`python3 scripts/...`, the verifiers, the extractors, the exporters)
or copies an upstream template or asset file, and check those rules by reading your own
SVG instead. For an import, read the source yourself: Mermaid text from the
page or chat, a `.drawio` file with the file tools, an Excalidraw whiteboard
with `draw_get`. Then follow the import guide from its second step.
