# Optional services

Switch the optional parts of a box on and off in **Settings > Services**. Switching off stops the service and keeps all its data.

Reading uploaded files is not optional: the parser does it on every box, with its own memory limit and no internet access.

| Service            | What it gives you                                                                                                                            | Download                      | Memory                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| **Sandboxes**      | Isolated workspaces where agents run code, build apps and test packages.                                                                     | about 430 MB                  | 512 MB, plus up to 1 GB per running sandbox (3 at a time) |
| **Local embedder** | Search vectors made on the box, so indexed text never leaves it.                                                                             | about 3.9 GB                  | up to 2 GB                                                |
| **Helpers**        | PDF export. Shown only on a small core box; a full box always runs it.                                                                       | about 900 MB                  | up to 1.5 GB                                              |
| **Documents**      | Office files to PDF, pages and HTML to PDF, and the PDF tools (merge, split, stamp, PDF/A) for agents, MCP and mini apps. **On by default.** | about 710 MB (2.4 GB on disk) | up to 2 GB                                                |
| **Calls**          | Voice calls between people in Messages. Off by default.                                                                                      | about 45 MB                   | up to 512 MB                                              |

**Documents** is on by default: a new box starts it, and an update switches it on for a box that does not run it yet. Switched off here, it stays off.

**Calls** runs LiveKit, a media server, on the box. It needs a domain with HTTPS and four ports open at the cloud edge: UDP 7882, TCP 7881, TCP 5349 and UDP 3478. Until then, calls connect only on the local network.

## Before you start

- You need an admin login.
- Switching on needs at least 4 GB of free disk, or it is refused with nothing changed.
- On a small box (6 GB of memory or less, or a core box), the screen warns that a service can slow the brain down.

## Switch a service

1. Open **Settings > Services**.
2. Click the switch next to the service.
3. Read the confirm dialog and click **Switch on** or **Switch off**.
4. Wait while the box downloads and starts it.

Only one change runs at a time, and never during an update.

## Check it worked

The service shows as on in **Settings > Services** and in its pill on the dashboard.

## What switching off does

- **Sandboxes**: running sandboxes stop. Every sandbox, its files and its apps stay. Agents lose the sandbox tools until you switch it back on. Mini apps keep running.
- **Local embedder**: if **Settings > Embedding** uses it, new content is not searchable until you switch it back on. The confirm dialog warns you. The downloaded model stays.
- **Helpers**: PDF export stops. Every file type is still read, by the parser.
- **Documents**: agents, MCP and mini apps lose Office to PDF and the PDF tools. Page PDF export uses the helper where it runs.
- **Calls**: the Call button goes. A running call ends within a minute. Past calls stay in each chat.

## If it fails

The screen shows **The last switch did not work** with the reason. Click **Show the log** for the details. A failed switch puts `.env` back the way it was.

If the screen says the brain cannot switch services yet, update the box first. See [Update MantleOS](01-update.md).

## Next

- [Services screen help](../06-help/services.md)
- [Local models](06-local-models.md)
