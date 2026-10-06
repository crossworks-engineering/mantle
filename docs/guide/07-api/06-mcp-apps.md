# Build apps from an MCP client

Claude Code or Claude Desktop can build a Mantle mini-app for you, end to end, over MCP.

A mini-app is a small React (TSX) app that Mantle bundles and runs in a sandboxed frame under **Apps**. It reaches your data only through the tools you allow it, and it can keep its own small SQLite database.

## Before you start

Claude is connected to your Mantle ([Connect Claude over MCP](01-connect-claude.md)).

## Ask Claude

Tell Claude what you want, for example:

> Build me a Mantle app that lists my open tasks by due date. Read the app authoring guide first.

Claude then works through these tools:

| Tool | What it does |
| --- | --- |
| `app_authoring_guide` | Reads the rules: allowed imports, styling, the `@host` bridge, data access |
| `app_create` | Makes the app and returns its id |
| `app_source_set` or `app_file_write` | Uploads the source, whole or one file at a time |
| `app_tools_set` | Lists the tools the app may call, for example `task_list` |
| `app_build`, then `app_publish` | Compiles the draft (every error comes back with file and line), then makes the green build live |

Every edit lands in the draft. The published app does not change until `app_publish`.

## Check it worked

Open **Apps** in Jackdaw and pick the app. The preview shows the draft build. After publishing, the live app shows the same.

## If it fails

- **The build fails**: Claude reads the errors from `app_build`, fixes the file and builds again. A failed build never replaces the last good one.
- **The app shows no data**: the tool it calls is missing from `app_tools_set`. The host refuses any tool not on that list.

## Next

- The full reference Claude reads: [App authoring guide](../../app-authoring-guide.md).
- [Apps](../03-using-jackdaw/10-apps.md): edit, publish and share in Jackdaw.
- [Member home apps](07-member-home-apps.md)
