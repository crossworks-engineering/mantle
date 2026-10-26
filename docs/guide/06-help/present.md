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

Present is agent driven. Ask in chat for a schematic, a deck, a dashboard or an animated explainer, and the assistant hands it to **Presenter**. You change a canvas the same way: ask for the change; the assistant makes a small change itself. There are no drawing tools.

- Canvases belong to workspaces, like pages and tables. Every workspace's assistant, and your own MCP client, can read and change canvases where you can: a new canvas lands in the workspace you moderate (else your private one), and you edit a canvas when you moderate its workspace or have Write on it.

- Presenter looks at every canvas it saves, in a real browser, and fixes what it sees before it reports.
- A P&ID or a process flow is drawn from data by a layout template, so the result is neat and the same every time. Draftsman uses the same path for the diagrams it puts in pages.
- To put a canvas in a page, ask for it, or type `/canvas` in the page and pick one. The page shows the canvas's latest picture. Click it to open the live canvas over the page; **Back to page** or Esc returns. A deck keeps its arrow keys and **Full screen**.
- The picture is the one Presenter took at its last save. If the canvas changed since, the page says that a newer version exists; open it to see.
- For outside Mantle (an email, a file to send), ask for a copy. The assistant exports a static copy into Files, where your other exports go, and says where it landed. That copy does not follow later changes.
- Deleting a canvas is a deliberate step: the assistant asks first.

## Technical

- A canvas is a `present` node with a sidecar that holds one HTML document, its text for search, and its compiled styles.
- The canvas runs in a locked frame: it cannot fetch or send data, and it has no database, no tools and no cookies. It can only draw. A canvas that tries to open another page in its frame is stopped and taken off the screen. The desktop app also stops the request before it leaves. In a web browser that one request still goes out, and it can carry what the canvas holds: its own content and a ticket that lasts 30 seconds. For a canvas that came from someone else, the desktop app is the safer place to open it.
- Libraries come from the brain, never from the internet: ECharts, Plotly, D3, Konva, Three.js, Motion, reveal.js, KaTeX and Alpine.js. Presenter reads a short guide for each (`canvas_library`), written for the exact version the brain serves.
- Search reads the canvas title, description and visible text. A canvas is indexed again only after five minutes without a text change, so many quick saves cost one pass.
- The last ten versions of each canvas are kept. Presenter can bring one back.
- In a page a canvas is `![Title](present:<id>)`. Who may open it is the canvas's own access, never the page's: a reader of the page who may not read the canvas sees a placeholder, with no picture and nothing of the canvas.
- Sharing works as it does for a drawing in a page. Sharing the page with a workspace does not share the canvas. The page's **Access** panel lists it under **Grant these too**; grant it there, and the workspace's users can open it. Taking the canvas out of the page ends that offer, but a grant already made stays until you remove it.
- On a share link (`/s/...`), and in the mobile apps, a page shows the picture only, never the live canvas. A link shows a canvas's picture only when you add the canvas to the link's served items in Access; otherwise it shows a placeholder. PDF and Word exports of the page carry the picture.
- The pictures need the browser sidecar (`BROWSER_WS_ENDPOINT`). Without it a canvas still saves and runs, but Presenter cannot look at its work, and nothing can be exported.
