---
title: Services
---

## Services

This screen switches the optional parts of the box on and off. Only admins see
it.

| Service | What it does | Download | Memory |
| --- | --- | --- | --- |
| **Sandboxes** | Containers where the coder and app agents run code and build apps | about 430 MB | 512 MB, plus up to 1 GB per running sandbox |
| **Media** | Transcripts from video and audio; reads CAD drawings (DWF, DWG, DXF) | about 300 MB | up to 1 GB (3 GB for large DWF sets) |
| **Local embedder** | Makes search vectors on this box, so indexed text never leaves it | about 3.9 GB | up to 2 GB |
| **Helpers** | Reads rare file types (ODT, PPTX, DOC, RTF) and makes PDF exports | about 1.2 GB | up to 3 GB |

**Helpers** show only on a small core box; a full box always runs them.

Switching a service **on** downloads it the first time and starts it, in one
to three minutes. Switching it **off** stops it and keeps everything, including
your sandboxes and what was already ingested. Mini apps keep running either
way.

Turning off the local embedder stops new content being indexed on a brain that
embeds with it. The confirm dialog warns you when that applies.

On a box with 6 GB of memory or less, or the core shape, the screen warns you
first: a busy service can slow the brain or make it restart. A switch needs at
least 4 GB of free disk. One switch runs at a time, and never during an
update. If a switch fails, the screen says why, can show the log, and puts the
settings back.

## Assistant

Agents have no tool for this screen, so an agent cannot give itself a
sandbox. The assistant can explain the services:

- "What stops working if I switch Media off?"
- "What does the Helpers service do?"

## Technical

The switch asks the box's updater to turn that service's compose profile on or
off and start or stop its container. The profiles are `sandboxes`, `media`,
`local-embedder` and `helpers`. The updater backs up `.env` first and restores
it if the start fails. Each switch writes a `service.toggle` row to the audit
log. More detail: [Optional services](../05-admin/04-services.md).
