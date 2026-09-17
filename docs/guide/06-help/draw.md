---
title: Draw
toolGroups: [draw-read]
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

The header row holds the drawing's icon, name, a one-line **description**
and tags; all save as you type. A drawing can be **embedded in a page**
(type `/drawing` in the page editor and pick it): the page shows the live
committed snapshot, so editing the drawing updates every page that embeds
it. Shared drawings appear in the team workspace, and a drawing can be
shared as a read-only public link like a page.

Pasted images live in Files (uploaded once, read once like any other file),
so deleting a drawing never deletes its images.

## Assistant

- "Find my sketch about the ingest pipeline."
- "What did I plan on the architecture whiteboard last week?"
- "Embed the deployment sketch in the runbook page."

Committed drawings are searchable like any other content: the assistant
reads a drawing's text, not its pixels, so label your shapes and name your
frames and it will find them. A page that embeds a drawing is also findable
by the drawing's own labels.

## Technical

A drawing is a `nodes` row (`type='draw'`) plus a `draws` sidecar holding
the Excalidraw scene JSON. Autosave writes a private `draft_scene`; Commit
promotes it, derives `scene_text` (frame names as headings, shape labels,
and labelled arrows as `A -> B: label` relations), captures an SVG snapshot
for previews, and fires the extractor — one index per commit, not one per
stroke. Concurrent edits are guarded by a draft etag: a stale writer gets a
conflict instead of silently overwriting. Scene images are `file` nodes
referenced by id, never bytes in the scene. Every non-editor surface (list,
page embeds, shares, exports) renders the snapshot as an image; when it is
missing or stale, a server-side browser re-renders it from the scene.
