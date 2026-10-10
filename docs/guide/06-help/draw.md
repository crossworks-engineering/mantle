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

- "Look at the onboarding flow drawing and tell me which steps are ticked."

The assistant reads a drawing's text first: frame names, shape labels and labelled arrows. Label your shapes and name your frames so it can find them. When positions, colours, ticks or layout matter, it can also look at the drawing as a picture. That needs a model that can see images; a text-only model gets the text. The picture is the last commit, the same image a share link shows. The assistant cannot draw or edit.

## Technical

- A drawing is a `draw` node with a sidecar holding the scene, the draft and a text version of it.
- On commit, frame names, shape labels and labelled arrows become searchable text, and a preview image is saved.
- Pasted images are stored in Files. Deleting a drawing keeps them.
- Tools: `draw_list`, `draw_get`. They read committed drawings only.
- `draw_get` with `image: true` also returns the committed preview as a PNG (white background, long edge 2000 px). `region` zooms into part of a wide scene. Over MCP the PNG is an image block next to the JSON. In chat and runs it goes to the model only when the model can see images.
- The picture follows the same rules as the text: whoever may call `draw_get` on a drawing may get its picture. A team member or a client gets it without the pasted images they may not open, as on their own preview. The drawing's text leaves out the words read from those images too.
