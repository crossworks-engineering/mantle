---
title: Draw
---

## Draw

A whiteboard per item: sketch an architecture, map out an idea, plan a
project visually. The canvas is Excalidraw, so everything you know from it
applies: shapes, arrows, frames, freehand, keyboard shortcuts.

Your strokes autosave into a **private draft** continuously; nothing is
shared or indexed until you **Commit** (the button, or Ctrl/Cmd+S).
**Revert** throws the draft away and returns to the last commit. The list's
preview shows the last committed snapshot; an uncommitted draft is only
visible in the editor itself.

Pasted images live in Files (uploaded once, read once like any other file),
so deleting a drawing never deletes its images.

## Assistant

- "Find my sketch about the ingest pipeline."
- "What did I plan on the architecture whiteboard last week?"

Committed drawings are searchable like any other content: the assistant
reads a drawing's text, not its pixels, so label your shapes and name your
frames and it will find them.

## Technical

A drawing is a `nodes` row (`type='draw'`) plus a `draws` sidecar holding
the Excalidraw scene JSON. Autosave writes a private `draft_scene`; Commit
promotes it, derives `scene_text` (frame names as headings, shape labels,
and labelled arrows as `A -> B: label` relations), captures an SVG snapshot
for previews, and fires the extractor — one index per commit, not one per
stroke. Concurrent edits are guarded by a draft etag: a stale writer gets a
conflict instead of silently overwriting. Scene images are `file` nodes
referenced by id, never bytes in the scene.
