# The HTTP API

MantleOS's public HTTP API lives under `/api/v1`. It is a versioned contract: a route there keeps its shape, and a breaking change ships as `/api/v2`. Version 1 stays for at least six months after version 2 ships.

The other `/api/` routes are the ones the app itself calls. They can change with any release. Use `/api/v1`, or MCP ([Connect Claude over MCP](01-connect-claude.md)), for anything you build.

## Authenticate

Use an API key ([API keys](08-api-keys.md)):

```sh
curl -s https://example.com/api/v1/whoami \
  -H "Authorization: Bearer mtlk_..."
```

A key acts as the login that made it, limited to its access and areas. A login token from `POST /api/auth/token` (email and password, 30 days) also works, with the login's full rights. Prefer a key: it can be limited and revoked on its own.

## Routes

A route answers a key the way the same route in the app answers the key's login. A key whose login is outside the Admin workspace can use the item routes (search, pages, notes, tasks, tables and their commit, files, events), and reads and changes only what that login may in its workspaces. Contacts, the journal and the table row writes are for logins in the Admin workspace: any other login's key gets `403` with `reason: "member-login"` from them.

| Method and path                           | Area      | Does                                |
| ----------------------------------------- | --------- | ----------------------------------- |
| `GET /api/v1/whoami`                      | none      | Who the key acts as, and its scope  |
| `GET /api/v1/search?q=&ws=`               | Search    | Search the brain, across workspaces |
| `GET /api/v1/nodes/{id}`                  | All areas | Read any item by id                 |
| `GET`, `POST /api/v1/pages`               | Pages     | List, create                        |
| `GET`, `PATCH /api/v1/pages/{id}`         | Pages     | Read, change                        |
| `GET`, `POST /api/v1/notes`               | Notes     | List, create                        |
| `GET /api/v1/notes/{id}`                  | Notes     | Read                                |
| `GET`, `POST /api/v1/tasks`               | Tasks     | List, create                        |
| `GET`, `PATCH /api/v1/tasks/{id}`         | Tasks     | Read, change                        |
| `GET /api/v1/tables`                      | Tables    | List                                |
| `GET /api/v1/tables/{id}`                 | Tables    | Read, with columns                  |
| `GET`, `POST /api/v1/tables/{id}/rows`    | Tables    | Read rows; add rows to the draft    |
| `PATCH /api/v1/tables/{id}/rows/{rowId}`  | Tables    | Change one row in the draft         |
| `POST /api/v1/tables/{id}/commit`         | Tables    | Publish the draft                   |
| `GET`, `POST /api/v1/files`               | Files     | List, upload                        |
| `GET /api/v1/files/{id}`                  | Files     | File details                        |
| `GET /api/v1/files/{id}/download`         | Files     | The bytes                           |
| `GET`, `POST /api/v1/events`              | Calendar  | List, create                        |
| `GET /api/v1/contacts`, `/{id}`           | Contacts  | List, read                          |
| `GET`, `POST /api/v1/journal`             | Journal   | List, create                        |
| `POST /api/v1/documents/{family}/{route}` | Files     | The documents engine (below)        |

A create (`POST` on pages, notes, tasks, files and events) takes `?ws=` with a workspace id, as in the app: the item lands in that workspace when the key's login may create there. Without it, the item lands where the app would put it.

Add rows with `{ "rows": [{ "Name": "Alpha" }] }`: each row is cells keyed by column name. Rows land on the table's draft. Commit to publish them.

## Search across workspaces

`GET /api/v1/search?q=` looks in every workspace the key's login reads. Each hit names the workspace it opens in, as `workspace: { id, name }`, one of the login's own workspaces. A hit that none of them reads has no `workspace`.

Add `ws=<workspace id>` to put the hits of that workspace first. It does not narrow the search. The answer echoes it as `ws`. A workspace the key's login is not a user of, or an id that is not a workspace, gets `404`.

```sh
curl -s "https://example.com/api/v1/search?q=invoice&ws=<workspace id>" \
  -H "Authorization: Bearer mtlk_..."
```

## Documents: PDF and Office conversions

When the brain's **Documents** service is on (Settings > Services), `POST /api/v1/documents/<family>/<route>` runs the documents engine (Gotenberg). The path mirrors the engine's own routes without `/forms/`:

| Route                                                                                                                         | Does                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `chromium/convert/html`, `.../markdown`, `.../url`                                                                            | HTML, markdown, or a page or drawing of the brain (`node_id`) to PDF |
| `chromium/screenshot/html`, `.../markdown`, `.../url`                                                                         | The same, to a PNG, JPEG or WebP picture                             |
| `libreoffice/convert`                                                                                                         | Word, Excel, PowerPoint, OpenDocument, RTF and more to PDF           |
| `pdfengines/merge`, `split`, `flatten`, `convert`, `encrypt`, `embed`, `watermark`, `stamp`, `rotate`, `optimize`, `factur-x` | The PDF tools                                                        |
| `pdfengines/metadata/read`, `pdfengines/metadata/write`                                                                       | Metadata (JSON answer for read)                                      |
| `pdfengines/bookmarks/read`, `pdfengines/bookmarks/write`                                                                     | Bookmarks, the outline (JSON answer for read)                        |

One body for every route:

```json
{
  "inputs": { "file_ids": ["<file id>", "<file id>"] },
  "options": { "pdfa": "PDF/A-2b" },
  "filename": "q3-pack"
}
```

`inputs` are references into the brain, never paths: `file_ids` (files the key's login may read), `node_id` (a page or a drawing, printed as the login), `html` or `markdown` (inline text, 4 MB at most), `asset_file_ids` (images and CSS beside the HTML), `header_html` and `footer_html` (full HTML documents; `<span class="pageNumber"></span>` and `totalPages` are filled in), and `watermark_file_id`, `stamp_file_id`, `facturx_file_id`, `embed_file_ids` on the routes that take them. One input may be 64 MB, all of them 128 MB, fifty files at most.

`options` use the engine's own field names ([the Gotenberg docs](https://gotenberg.dev/docs/routes) are the reference: `paperWidth`, `marginTop`, `landscape`, `printBackground`, `waitForExpression`, `pdfa`, `metadata`, `splitMode`, `userPassword` and the rest). An unknown field is a `400` that names it. `url`, `cookies`, `extraHttpHeaders`, `userAgent`, `downloadFrom`, the webhook fields and the raw file fields are the brain's own and are refused: the engine fetches nothing and prints only this brain.

The answer is `201` with the file the output landed in (`file: { id, name, path, sizeBytes, mimeType, landedIn }`; Auto-filed / Exports for an Admin login, else the top of Files), or, with `?return=bytes`, the bytes themselves as a download (PDF, a zip when the engine made several files, or the picture). The two read routes answer `{ result }` and save nothing. `409` means the engine could not render (the message says why), `413` too large, `503` the service is off, busy or not answering.

```sh
curl -s https://example.com/api/v1/documents/libreoffice/convert \
  -H "Authorization: Bearer mtlk_..." -H "Content-Type: application/json" \
  -d '{"inputs":{"file_ids":["<file id>"]},"options":{"landscape":true}}'
```

**System > API Console** shows example bodies for the routes the app uses ([API console](04-api-console.md)).

## Errors

| Status                               | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `401`                                | No key, a wrong key, or a revoked or expired one                          |
| `403` with `reason: "key-read-only"` | A read only key tried to write                                            |
| `403` with `reason: "key-area"`      | The route is outside the key's areas                                      |
| `403` with `reason: "member-login"`  | A route for logins in the Admin workspace, and the key's login is not one |
| `404`                                | Not a `/api/v1` route, no such item, or a `ws` the login cannot name      |
| `429`                                | Too many requests; wait for `Retry-After` seconds                         |

## Calling from a browser on another origin

A web page on another origin needs its origin listed in `MANTLE_API_CORS_ORIGINS` ([Environment variables](../05-admin/03-env-vars.md)).

## Next

- [API keys](08-api-keys.md)
- [API console](04-api-console.md)
- [Connect Claude over MCP](01-connect-claude.md)
