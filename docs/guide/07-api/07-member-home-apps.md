# Member home apps

Make one of your mini-apps the home page every member login sees, and feed it the member's pages, apps and counts through `host.hub`.

## Before you start

- A published app ([Build apps from an MCP client](06-mcp-apps.md)).
- At least one member login ([Member and client logins](../05-admin/07-logins.md)).

## Pin the app

1. Open **Team** in the menu (under Review), then the **Settings** tab.
2. Under **Member home app**, pick the app in **Home app**.

Picking an app sets it to Team level, so every member can run it. Members always get the published build. If the app breaks (unpublished, a failed build, deleted), members get the **Built-in home** instead. Pick **Built-in home** to go back by hand.

## Read the member's data

```ts
import { host } from '@host';

const hub = await host.hub.get();
```

`hub` holds:

| Field | What it is |
| --- | --- |
| `siteName` | Your brain's site name |
| `memberName` | The signed-in member's name |
| `sections` | The newest team-level pages: `token`, `title`, `icon`, `summary`, `updatedAt` |
| `counts` | How many items of each kind the member's Library holds (`page`, `note`, `draw`, `table`, `file`) |
| `apps` | The other apps members may run: `token`, `title`, `description` |

The app asks the shell to open things. It never opens them itself:

| Call | Opens |
| --- | --- |
| `host.hub.openBriefing(token)` | That page in the member's Library |
| `host.hub.openApp(token)` | That app |
| `host.hub.openChat()` | The member's chat |

`host.me()` tells the app who runs it.

## Preview in the editor

`host.hub.get()` fails in your own app editor, because no member is signed in. Catch it and show labelled sample data, so the preview still renders:

```ts
let hub = SAMPLE_HUB;
try {
  hub = await host.hub.get();
} catch {
  // not a member's home: keep the sample
}
```

## Keep it up to date

| What changes | How you update it |
| --- | --- |
| Copy and layout in the code | Edit the source, `app_build`, `app_publish` |
| Tiles you want to edit often | Keep them in a Table. Allow `table_rows_list` with `app_tools_set` and read the rows. Editing and committing the table updates the home, no publish needed |
| Member input (polls, read receipts) | Use the app's own SQLite (`host.db`). Write `:host_me_id` in the SQL to record who did it; the server fills it in |

Members see changes on their next page load.

## Next

- The full app reference: [App authoring guide](../../app-authoring-guide.md).
- [Team and members](../03-using-jackdaw/12-team.md)
