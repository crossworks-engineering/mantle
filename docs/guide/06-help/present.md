---
title: Present
toolGroups: [present, present-read, present-admin]
---

## Present

Present holds canvases. A canvas is a picture that can move: a diagram, a process schematic, an animated explainer, a chart or a slide deck. An agent writes each one as a small web page, and Present runs it.

- Canvases live in folders. Drag them into the order you want.
- **Maximise** hides the menus and the folders. Esc brings them back.
- **Full screen** fills the screen, for presenting. In a deck, the arrow keys move between slides.
- **Replay from the start** runs it again. **Source (read only)** shows the page the agent wrote.
- A canvas traced from a drawing shows **Image checks** under it. They help, but check the drawing.

You always see the latest save. There is no draft and no commit step.

### Share a canvas

Open the canvas and click **Access** in its header.

- **A workspace:** use **Add workspace**. Its users can then open it. You need to be a Moderator of the canvas's workspace and of the workspace you add.
- **An open link:** click **Make an open link**, then **Copy link**. Anyone with the link sees the canvas live and full screen, with no login. **Stop the link** ends it at once, and so does deleting the canvas.
- Only a Moderator of the canvas's home workspace can make, change or stop its link. Edit rights are not enough: the link runs the canvas's code for anyone.
- The link shows the latest save, so a change is public at once. Anyone with it can read the whole canvas, its source too. Keep private data out. A canvas that saves data (notes or votes) saves nothing on a link.

### Sound and pictures from Files

A canvas can play narration or show a picture kept in Files.

- The canvas lists each file it uses. It plays only those.
- Each viewer gets a file only if they can open it in Files. Anyone else gets the canvas's fallback: captions, a computer voice, or nothing.
- An open link plays the listed files too: they are part of the canvas, as images are part of a page. It plays only a file in the canvas's own workspace.
- Pictures of a canvas (the page picture, exports) have no sound.

## Assistant

Ask in chat for a schematic, a deck, a dashboard or an animated explainer, and the assistant hands it to **Presenter**. Ask for changes the same way; the assistant makes a small one itself. There are no drawing tools.

- A new canvas lands in a workspace you moderate, or else your private one. You can edit a canvas when you moderate its workspace or have Write on it.
- Presenter looks at every canvas it saves, in a real browser, and fixes what it sees.
- To put a canvas in a page, ask, or type `/canvas` there. The page shows its picture. Click it for the live canvas; **Back to page** or Esc returns.
- Ask for a static copy to use outside the brain. It lands in Files, and it does not follow later changes.
- The assistant asks before it deletes a canvas.

## Technical

- A canvas is a `present` node holding one HTML document. The last ten versions are kept; Presenter can bring one back.
- It runs in a locked frame: no network, no database, no tools, no cookies. Only the brain's pages, the web app, MantleOS Desktop and the origins in `MANTLE_API_CORS_ORIGINS` may hold that frame. The desktop app is the safer place to open a canvas from someone else.
- Libraries (ECharts, Plotly, D3, Three.js, reveal.js and more) come from the brain, never the internet. `canvas_library` has a guide for each.
- Search reads its title, description, visible text and summary, five minutes after the last text change.
- In a page a canvas is `![Title](present:<id>)` and keeps its own access. The page's **Access** panel lists it under **Grant these too**. A reader who may not read it sees a placeholder. Share links, the mobile apps and PDF and Word exports show its picture only.
- A canvas's own link (`/s/<token>`) is checked on every frame load; a frame ticket lasts 30 seconds.
- `mantle.media` hands a canvas the files its head declares (`<meta name="canvas:assets">`): the page around the frame fetches each one as the viewer (an open link: through the link, which serves the declared files of the canvas's own workspace). mp3, ogg, png, jpeg and webp, up to 10 MB each. `speech_file_create` makes narration clips; `canvas_library media` has the guide.
- Pictures, checks and exports need the browser sidecar (`BROWSER_WS_ENDPOINT`). Without it a canvas still saves and runs.
