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
- Imports are limited to React, the built-in UI kit, Lucide icons, the host bridge, the app's own files and the libraries the brain serves. Charts and pictures: ECharts, D3, Three.js, Konva, KaTeX, Motion and the diagram templates. Work: math.js (units and engineering maths), date-fns (dates), Zod (form checks), TanStack Table and Virtual (big grids, long lists), dnd-kit (drag and drop), Fuse.js (fuzzy search), Papa Parse (CSV), pdf-lib (make a PDF), qrcode (labels and tags), and markdown-it with DOMPurify (markdown, always sanitized). The app specialist reads a short guide for each (`canvas_library`), written for the exact version the brain serves.
- An app has no network: it cannot load map tiles or call an outside API, and it cannot download a file. Data comes from the brain through the tools you allow.
- An app can show a stored picture or drawing. `file_read` and `dwg_render` with `bytes: true` hand the app the file as base64, at most 16 MB a call. Only an app's own call gets the bytes; an agent or MCP client is told what to use instead.
- An app can run WebAssembly, for example Rust built in a sandbox. The frame has no network, so the module ships inside the app's code as base64. `eval` and `new Function` stay blocked.
- An app can have its own SQLite database. `app_db_list` and `app_db_query` let the assistant read it.
- **MCP access** (beside **Informational** on the app) lets the users who run the app reach its data from their own MCP client: they read it, and where their grant has **Writable** on they change rows (never the schema), unless the app is informational. Off by default. See [MCP as a login](../07-api/02-mcp-login.md).
- An app can make a PDF or a picture with the documents tools (`pdf_render`, `screenshot_render`, `office_to_pdf`, `pdf_tools`), declared like any tool. With `bytes: true` the app gets the file back and nothing is saved. Without it, an admin's app saves to Auto-filed / Exports, and a team app saves at the top of Files in the app's own workspace, only for a user who moderates that workspace. A shared link calls none of them.
- Building uses `app_create`, `app_file_write`, `app_build`, `app_tools_set` and others. Delete and publish (`app_delete`, `app_publish`) are in a separate admin group.
- Changing an app's code in place uses the code tools: `code_view` and `code_search` read it, `code_edit`, `code_insert` and `code_write` change one file and return a diff, and `code_undo` takes one write back by the `edit_id` it returned, only while its files are as that write left them. They are in the same group as `app_file_write` and ask the same access.
- For an audit, `app_log` lists an app's versions and snapshots (who and when), and `code_diff` compares two of them, or the live app and its draft. `app_export` with `format: "git"` saves the versions as a git bundle for `git clone`: code only, one commit per version. A bundle made from it and changed outside comes back into the draft with `app_source_from_bundle`, only when it holds the live version.
- Each publish gives the app a short summary: what it is, who it is for, how to use it and the tables it keeps. Search and the assistants find the app by it. The agent that built the app writes it (`summary` on `app_publish`), and it stays until a new one is passed. Without one, the summarizer worker writes it once when the app is indexed after the publish, from the app's description, tools, schema and the start of its code, and only when a workspace with an assistant reads the app. A publish that changed neither the code nor the manifest keeps the summary it has, and a summary the agent wrote is never replaced by a generated one.
- More: [Apps](../03-using-jackdaw/10-apps.md).
