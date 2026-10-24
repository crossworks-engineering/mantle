---
title: Present
toolGroups: [present, present-read, present-admin]
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

Present is agent driven. Ask in chat for a schematic, a deck, a dashboard or an animated explainer, and the assistant hands it to **Presenter**. You change a canvas the same way: ask for the change. There are no drawing tools.

- Presenter looks at every canvas it saves, in a real browser, and fixes what it sees before it reports.
- A P&ID or a process flow is drawn from data by a layout template, so the result is neat and the same every time. Draftsman uses the same path for the diagrams it puts in pages.
- To put a canvas in a page, ask for it. The assistant exports a static copy into Files (`files/diagrams`) and embeds it. Print, PDF, Word, email and shares show that copy. The canvas stays the one you change; after a change, ask for the page copy to be updated.
- Deleting a canvas is a deliberate step: the assistant asks first.

## Technical

- A canvas is a `present` node with a sidecar that holds one HTML document, its text for search, and its compiled styles.
- The canvas runs in a locked frame: it cannot fetch or send data, and it has no database, no tools and no cookies. It can only draw. A canvas that tries to open another page in its frame is stopped and taken off the screen. The desktop app also stops the request before it leaves. In a web browser that one request still goes out, and it can carry what the canvas holds: its own content and a ticket that lasts 30 seconds. For a canvas that came from someone else, the desktop app is the safer place to open it.
- Libraries come from the brain, never from the internet: ECharts, Plotly, D3, Konva, Three.js, Motion, reveal.js, KaTeX and Alpine.js. Presenter reads a short guide for each (`canvas_library`), written for the exact version the brain serves.
- Search reads the canvas title, description and visible text. A canvas is indexed again only after five minutes without a text change, so many quick saves cost one pass.
- The last ten versions of each canvas are kept. Presenter can bring one back.
- The pictures need the browser sidecar (`BROWSER_WS_ENDPOINT`). Without it a canvas still saves and runs, but Presenter cannot look at its work, and nothing can be exported.
