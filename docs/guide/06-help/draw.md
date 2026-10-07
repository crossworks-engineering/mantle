---
title: Draw
toolGroups: [draw-read]
---

## Draw

Draw is a whiteboard for sketches, diagrams and plans. The canvas is Excalidraw, so its shapes, arrows, frames and shortcuts all work.

- Click **New** to start a drawing. Name it and add a description and tags in the header.
- Your strokes save to a private draft as you work.
- Click **Commit** (or press Ctrl/Cmd+S) to publish the draft. Only committed drawings are shared and searchable.
- **Revert** throws the draft away and goes back to the last commit.
- To show a drawing in a page, type `/` in the page editor and pick **Drawing**. The page shows the latest commit.

Share a drawing or export it from the header.

## Assistant

- "Find my sketch about the ingest pipeline."
- "What did I plan on the architecture whiteboard?"

The assistant reads a drawing's text, not its pixels. Label your shapes and name your frames so it can find them. It cannot draw or edit.

## Technical

- A drawing is a `draw` node with a sidecar holding the scene, the draft and a text version of it.
- On commit, frame names, shape labels and labelled arrows become searchable text, and a preview image is saved.
- Pasted images are stored in Files. Deleting a drawing keeps them.
- Tools: `draw_list`, `draw_get`. They read committed drawings only.
