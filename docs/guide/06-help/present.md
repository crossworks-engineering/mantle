---
title: Present
toolGroups: []
---

## Present

Present holds canvases. A canvas is a picture that can move: a diagram, a process schematic, an animated explainer, a chart or a slide deck. An agent writes each one as a small web page, and Present runs it.

- Canvases live in folders, like drawings and apps. Use the folder rail to sort them.
- Open a canvas to see it live. Animations play and charts respond.
- **Maximise** hides the menus and the folders. Press Esc to bring them back.
- **Full screen** fills the whole screen with the canvas, for presenting. In a deck, the arrow keys move between slides.
- **Replay** starts the canvas again from the beginning.
- **Source** shows the page the agent wrote. It is read-only.

The latest save is always what you see. There is no draft and no commit step.

## Assistant

Present is agent driven. You change a canvas by asking for the change in chat. There are no drawing tools.

## Technical

- A canvas is a `present` node with a sidecar that holds one HTML document, its text for search, and its compiled styles.
- The canvas runs in a locked frame: no network, no database, no tools, no cookies. It can only draw.
- Libraries come from the brain, never from the internet: ECharts, Plotly, D3, Konva, Three.js, Motion, reveal.js, KaTeX and Alpine.js.
- Search reads the canvas title, description and visible text. A canvas is indexed again only after five minutes without a text change, so many quick saves cost one pass.
- The last ten versions of each canvas are kept.
