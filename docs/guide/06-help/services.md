---
title: Services
---

## Services

Some parts of this box are optional, and you switch them on and off here. The
screen gives each one a line on what it enables and a switch. The details are
below. Helpers show only on a small core box; on a full box they always run.

### Sandboxes

Isolated workspaces where the coder and app agents run code, build apps and
test packages. Each sandbox is its own Linux container with no route to your
data.

- **Used by:** the coder agent and the sandbox tools, and services or MCP
  servers an agent runs inside a sandbox.
- **While it is off:** agents cannot create or use sandboxes. Running sandboxes
  stop, and services published from a sandbox stop answering. Their tools drop
  out of each agent's list and come back when you switch it on.
- **Kept while it is off:** every sandbox, its files and the apps and services
  in it.
- **Cost:** about 430 MB to download. 512 MB of memory, plus up to 1 GB for
  each running sandbox (three at a time).

Mini apps do not need sandboxes. They keep running whichever way this switch
is set.

### Media

Transcripts from video and audio (a web link or an uploaded file), and CAD
drawings: DWF, DWG and DXF.

- **Used by:** the video ingest tool, and file ingest for CAD drawings.
- **While it is off:** video and audio get no transcript. DWG files are not
  read, and DWF files show only their small preview pictures.
- **Kept while it is off:** everything already ingested. Media stores nothing
  of its own.
- **Cost:** about 300 MB to download. Up to 1 GB of memory; 3 GB is advised for
  large DWF drawing sets.

Media runs a downloader that updates itself every day and fetches pages from
the open web. It holds no keys and cannot reach your data.

### Local embedder

Turns text into search vectors on this box, so the text you index never leaves
it. It is the bundled EmbeddingGemma model.

- **Used by:** search and ingest, when Settings > Embedding uses the local
  provider on the bundled address. A brain that embeds online does not use it.
- **While it is off:** a brain that embeds with it cannot index new content.
  New files, notes and pages are not searchable until you switch it on again.
  The confirm dialog warns you when this brain uses it.
- **Kept while it is off:** the downloaded model and everything already
  indexed.
- **Cost:** about 3.9 GB to download the first time (the server and the
  model). Up to 2 GB of memory.

It runs on the processor, not a graphics card. It does not fit a small core
box well; use online embedding there.

### Helpers

Two small helpers for a core box. Tika reads rare file types, and a headless
browser makes PDF exports.

- **Used by:** file ingest for formats the brain cannot read itself (ODT,
  PPTX, DOC, RTF and others), PDF export, and drawing pictures in exports.
- **While it is off:** those rare file types are not read, and PDF export
  stops. PDF, Word, text and Markdown files are still read.
- **Kept while it is off:** everything already ingested. The helpers store
  nothing.
- **Cost:** about 1.2 GB to download. Up to 3 GB of memory (1.5 GB each).

### Switching

Switching a service **on** downloads it (the first time only) and starts it.
That takes one to three minutes. The rest of the brain keeps running.

Switching a service **off** stops it and **keeps everything**. Switch it on
again and it all comes back.

Only admins see this screen. One switch runs at a time, and not during an
update.

## Before you change anything

On a small box (about 4 GB of memory, or the small core setup) the screen
warns you first. The brain and its workers share that memory, so a busy service
can slow them down or make them restart. If that happens, switch the service
off again. The warning never blocks you; you decide.

The box also needs at least 4 GB of free disk to switch a service on. With less
than that, the switch is refused and nothing changes.

If a switch fails, the screen says why and can show the log. The box puts its
settings back as they were.

## Technical

The switch asks the box's updater to change the service's compose profile and
start or stop that one container. It backs up `.env` first and puts it back if
the start fails. A box can switch services one update after it gets this
screen, because the updater learns the new request then. Each switch writes a
`service.toggle` row to the audit log. Agents have no tool for it, so an agent
cannot give itself a sandbox. Each service name is also its compose profile:
`sandboxes`, `media`, `local-embedder` and `helpers`. The local embedder also
runs its one-shot model download when it comes on. The helpers have a profile
only on the core shape, so the screen and the updater offer them only there.
The full story is in the Services documentation (`docs/services.md`).
