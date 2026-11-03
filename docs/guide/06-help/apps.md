---
title: Apps
toolGroups: [apps, app-admin, app-data]
---

## Apps

Apps are small tools built on your own data: a job sheet, a stock count, a booking form or a one-page dashboard.

- Click **New** (or **New app inside** on a folder's menu), give it a **Name** and a **Description**, then **Create app**.
- Open an app to run it. **Open app** takes you to its editor.
- In the editor, the **View** menu switches between **Builder** (the running draft), **Code**, **History** and **Activity**.
- Click **Preview** to compile the draft and try it. Nothing goes live.
- Click **Commit** to compile and publish. A build that fails never replaces the last working one. **Discard the draft** drops the draft.
- **Access** chooses who can open the app. **App settings** holds **Informational** (only Admin can change its data) and **Trust its tools**.
- **History** lists every version and snapshot. **Take snapshot** before a risky change. Restore the code to the draft, restore the data, or roll the whole app back.

## Assistant

- "Build me an app for logging generator hours."
- "Add a filter by month to the stock app."
- "How many entries are in the stock app this week?"
- "What changed in the stock app since last week?"

Building and changing apps is handed to the app specialist. It writes the code, compiles it and fixes errors by file and line. Ask it to show you the preview before it publishes.

## Technical

- An app is real code: TSX files (up to 50, 256 KB each) compiled on the server. The entry file default-exports an `App` component.
- It runs in a sandboxed frame with no access to your session or cookies, and no network. It reaches your data only through the tools you allow for that app.
- It may import React, the built-in UI kit, Lucide icons, the host bridge, its own files and the libraries the brain serves: charts, 3D, maths and units, dates, form checks, big grids, drag and drop, fuzzy search, CSV, PDF, QR codes and markdown. The app specialist reads a short guide for each (`canvas_library`).
- An app can run WebAssembly. With no network, the module ships inside the app's code as base64. `eval` and `new Function` stay blocked.
- An app can show a stored picture or drawing: `file_read` and `dwg_render` with `bytes: true` hand the file to the app, at most 16 MB a call. With `bytes: true` the documents tools (`pdf_render`, `screenshot_render`, `office_to_pdf`, `pdf_tools`) give the app a PDF or a picture and save nothing.
- An app can have its own SQLite database. `app_db_list` and `app_db_query` let the assistant read it.
- **MCP access** in the Access panel lets the users who run the app reach its data from their own MCP client. Off by default. See [MCP as a login](../07-api/02-mcp-login.md).
- The code tools change an app in place: `code_view` and `code_search` read it; `code_edit`, `code_insert` and `code_write` change one file and return a diff; `code_undo` takes one write back.
- For an audit, `app_log` lists versions and snapshots (who and when), and `code_diff` compares two of them. `app_export` with `format: "git"` saves the versions as a git bundle; `app_source_from_bundle` brings a changed bundle back into the draft.
- Each publish gives the app a short summary: what it is, who it is for and how to use it. Search and the assistants find the app by it.
- Building uses `app_create`, `app_file_write`, `app_build`, `app_tools_set` and others. Delete and publish (`app_delete`, `app_publish`) are in a separate admin group.
- More: [Apps](../03-using-jackdaw/10-apps.md) and the [app authoring guide](../../app-authoring-guide.md).
