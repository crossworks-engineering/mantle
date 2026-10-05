---
title: Services
---

## Services

Two parts of this box are optional, and you switch them on and off here:

- **Sandboxes**: isolated workspaces where the coder and app agents run code,
  build apps and test packages. Each sandbox is its own Linux container with no
  route to your data.
- **Media**: transcripts from video and audio (a web link or an uploaded file),
  and CAD drawings (DWF, DWG and DXF).

Each row says what the service does, what uses it, what stops while it is off,
how much it downloads and how much memory it can use.

Switching a service **on** downloads it (a few hundred MB the first time) and
starts it. That takes one to three minutes. The rest of the brain keeps
running.

Switching a service **off** stops it and **keeps everything**: every sandbox,
its files and its apps, and everything Media already ingested. Switch it on
again and it all comes back.

Only admins see this screen. One switch runs at a time, and not during an
update.

## Before you change anything

On a small box (about 4 GB of memory) the screen warns you first. The brain and
its workers share that memory, so a busy service can slow them down. If that
happens, switch the service off again.

## Technical

The switch asks the box's updater to change the service's compose profile and
start or stop that one container. It backs up `.env` first and puts it back if
the start fails. A box can switch services one update after it gets this
screen, because the updater learns the new request then. The full story is in
the Services documentation (`docs/services.md`).
