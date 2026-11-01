# Build apps from an MCP client

Claude Code or Claude Desktop can build a MantleOS mini-app for you, end to end, over MCP.

A mini-app is a small React (TSX) app that MantleOS bundles and runs in a sandboxed frame under **Apps**. It reaches your data only through the tools you allow it, and it can keep its own small SQLite database.

## Before you start

Claude is connected to your brain ([Connect Claude over MCP](01-connect-claude.md)).

## Ask Claude

Tell Claude what you want, for example:

> Build me a MantleOS app that lists my open tasks by due date. Read the app authoring guide first.

Claude then works through these tools:

| Tool                                                  | What it does                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `app_authoring_guide`                                 | Reads the rules: allowed imports, styling, the `@host` bridge, data access                                        |
| `app_create`                                          | Makes the app and returns its id                                                                                  |
| `app_source_set` or `app_file_write`                  | Uploads the source, whole or one file at a time                                                                   |
| `code_view`, `code_search`                            | Reads one file (or some of its lines) and finds text across the files                                             |
| `code_edit`, `code_insert`, `code_write`, `code_undo` | Changes a file in place: replaces exact text, adds lines, writes a file, or puts a file back. Each returns a diff |
| `app_tools_set`                                       | Lists the tools the app may call, for example `task_list`                                                         |
| `app_build`, then `app_publish`                       | Compiles the draft (every error comes back with file and line), then makes the green build live                   |

Every edit lands in the draft. The published app does not change until `app_publish`.

To change an app you already have, ask Claude to fix or change it. It finds the place with `code_search`, reads the lines with `code_view`, and replaces only those lines with `code_edit`. Claude passes the revision it read: if you or another agent changed the draft in the meantime, the edit fails and Claude reads the file again, so no change is lost.

To see what changed between versions, ask Claude to compare them. `app_log` lists the versions (who published each and when) and `code_diff` shows the change between two of them, or between the live app and the draft. For a copy of the whole history, `app_export` with `format: "git"` saves a git bundle: download it with your API key (`GET /api/v1/files/{id}/download`) and run `git clone` on it. Each version is one commit, so `git log`, `git blame` and `git bisect` work. The bundle holds code only, no data.

## Check it worked

Open **Apps** in the app and pick the app. The preview shows the draft build. After publishing, the live app shows the same.

## If it fails

- **The build fails**: Claude reads the errors from `app_build`, fixes the file and builds again. A failed build never replaces the last good one.
- **The app shows no data**: the tool it calls is missing from `app_tools_set`. The host refuses any tool not on that list.

## Next

- The full reference Claude reads: [App authoring guide](../../app-authoring-guide.md).
- [Apps](../03-using-jackdaw/10-apps.md): edit, publish and share in the app.
- [Workspace home apps](07-member-home-apps.md)
