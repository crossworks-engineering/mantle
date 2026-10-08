---
title: Apps
toolGroups: [apps, app-admin, app-data]
---

## Apps

Apps are small tools built on your own data: a job sheet, a stock count, a booking form or a one-page dashboard.

- Click **New app**, give it a **Name** and a **Description**, then **Create app**.
- Edit it in **Builder** or **Code**. **History** and **Activity** show past versions and use.
- Click **Preview** to compile the draft and try it. Nothing goes live.
- Click **Commit** to compile and publish. A build that fails never replaces the last working one. **Discard** drops the draft.
- Use the access control to choose who can open the app.

## Assistant

- "Build me an app for logging generator hours."
- "Add a filter by month to the stock app."
- "How many entries are in the stock app this week?"

Building and changing apps is handed to the app specialist. It writes the code, compiles it and fixes errors by file and line. Ask it to show you the preview before it publishes.

## Technical

- An app is real code: TSX files (up to 50, 256 KB each) compiled on the server. The entry file default-exports an `App` component.
- It runs in a sandboxed iframe with no access to your session or cookies. It reaches your data only through the tools you allow for that app.
- Imports are limited to React, the built-in UI kit, Lucide icons, the host bridge and the app's own files.
- An app can have its own SQLite database. `app_db_list` and `app_db_query` let the assistant read it.
- **MCP access** (beside **Informational** on the app) lets members and clients reach the app's data from their own MCP client: they read it, and with their **Write** switch on they change rows (never the schema), unless the app is informational. Off by default. See [MCP as a login](../07-api/02-mcp-login.md).
- Building uses `app_create`, `app_file_write`, `app_build`, `app_tools_set` and others. Delete and publish (`app_delete`, `app_publish`) are in a separate admin group.
- More: [Apps](../03-using-jackdaw/10-apps.md).
