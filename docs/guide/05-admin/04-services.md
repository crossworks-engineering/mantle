# Optional services

Switch the optional parts of a box on and off in **Settings > Services**. Switching off stops the service and keeps all its data.

Reading uploaded files (documents, CAD drawings, the sound of a video) is not optional: the parser service does it on every box, with its own memory limit and no internet access.

| Service | What it gives you | Download | Memory |
|---|---|---|---|
| **Sandboxes** | Isolated workspaces where agents run code, build apps and test packages. | about 430 MB | 512 MB, plus up to 1 GB per running sandbox |
| **Local embedder** | Search vectors made on the box, so indexed text never leaves it. | about 3.9 GB | up to 2 GB |
| **Helpers** | PDF export. Shown only on a small core box; a full box always runs it. | about 1 GB | up to 1.5 GB |

## Before you start

- You need an admin login.
- Switching on needs at least 4 GB of free disk, or it is refused with nothing changed.
- On a box with about 4 GB of memory, a service can slow the brain down. The screen warns you first.

## Switch a service

1. Open **Settings > Services**.
2. Click the switch next to the service.
3. Read the confirm dialog and click **Switch on** or **Switch off**.
4. Wait while the box downloads and starts the service.

Only one change runs at a time, and never during an update.

## Check it worked

The service shows as on in **Settings > Services**. Its pill on the dashboard shows the same state.

## What switching off does

- **Sandboxes**: running sandboxes stop. Every sandbox, its files and its apps stay. Agents lose the sandbox tools until you switch it back on. Mini apps keep running.
- **Local embedder**: if **Settings > Embedding** uses it, new content is not searchable until you switch it back on. The confirm dialog warns you. The downloaded model stays.
- **Helpers**: PDF export stops. Every file type is still read: reading files is the parser's job, and the parser is always on.

## If it fails

The screen shows **The last switch did not work** with the reason. Click **Show the log** for the details. A failed switch puts `.env` back the way it was.

If the screen says the brain cannot switch services yet, update the box first. See [Update MantleOS](01-update.md).

## Next

- [Services screen help](../06-help/services.md)
- [Local models](06-local-models.md)
