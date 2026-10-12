# Workspace home apps

Every workspace has a landing page: what its users see at **Home** while it is their current workspace. By default it is the **Built-in home**. Make one of your mini-apps the landing page of a workspace instead, and feed it that workspace's pages, apps and counts through `host.hub`.

## Before you start

- A published app ([Build apps from an MCP client](06-mcp-apps.md)).
- You are a **Moderator** of the workspace.

## Set the landing page

1. Share the app with the workspace (**Grant Access** on the app).
2. Open **Settings > Workspaces** and pick the workspace.
3. Under **Landing page**, pick the app.

Only apps the workspace holds, with a working published build, are in the list. Picking changes no grant. Users always get the published build. If the app breaks (unpublished, a failed build, deleted, or no longer shared with the workspace), the landing page shows the **Built-in home** instead. Pick **Built-in home** to go back by hand.

Each workspace has its own landing page. A user in two workspaces sees the other one after a switch. **All my workspaces** in the switcher always shows the Built-in home.

## Read the workspace's data

```ts
import { host } from '@host';

const hub = await host.hub.get();
```

`hub` holds:

| Field | What it is |
| --- | --- |
| `siteName` | Your brain's site name |
| `memberName` | The signed-in user's name |
| `sections` | The newest pages the workspace reads: `token`, `title`, `icon`, `summary`, `updatedAt` |
| `counts` | How many items of each kind the workspace reads (`page`, `note`, `draw`, `table`, `file`) |
| `apps` | The other apps the workspace holds that the user may run: `token`, `title`, `description` |

Everything is kept to what the workspace reads and to what the user may read. The Built-in home shows the same data.

The app asks the shell to open things. It never opens them itself:

| Call | Opens |
| --- | --- |
| `host.hub.openBriefing(token)` | That page |
| `host.hub.openApp(token)` | That app |
| `host.hub.openChat()` | The user's chat |

`host.me()` tells the app who runs it.

## Preview in the editor

`host.hub.get()` fails in your own app editor, because the app is not open as a landing page. Catch it and show labelled sample data, so the preview still renders:

```ts
let hub = SAMPLE_HUB;
try {
  hub = await host.hub.get();
} catch {
  // not a landing page: keep the sample
}
```

## Keep it up to date

| What changes | How you update it |
| --- | --- |
| Copy and layout in the code | Edit the source, `app_build`, `app_publish` |
| Tiles you want to edit often | Keep them in a Table. Allow `table_rows_list` with `app_tools_set` and read the rows. Editing and committing the table updates the home, no publish needed |
| User input (polls, read receipts) | Use the app's own SQLite (`host.db`). Write `:host_me_id` in the SQL to record who did it; the server fills it in |

Users see changes on their next page load.

## Next

- The full app reference: [App authoring guide](../../app-authoring-guide.md).
- Who reads and changes what: [Workspaces](../../workspaces.md).
