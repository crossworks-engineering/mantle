# The HTTP API

Mantle's public HTTP API lives under `/api/v1`. It is a versioned contract: a route there keeps its shape, and a breaking change ships as `/api/v2`. Version 1 stays for at least six months after version 2 ships.

The other `/api/` routes are the ones Jackdaw itself calls. They can change with any release. Use `/api/v1`, or MCP ([Connect Claude over MCP](01-connect-claude.md)), for anything you build.

## Authenticate

Use an API key ([API keys](08-api-keys.md)):

```sh
curl -s https://example.com/api/v1/whoami \
  -H "Authorization: Bearer mtlk_..."
```

A key acts as the login that made it, limited to its access and areas. A login token from `POST /api/auth/token` (email and password, 30 days) also works, with the login's full rights. Prefer a key: it can be limited and revoked on its own.

## Routes

A route answers a key as the login it acts as, as the same route in the app does. A key of a login outside the Admin workspace reads and changes, in that login's workspaces, what the login may there: the item routes (search, pages, notes, tasks, tables and their commit, files, events). Contacts, the journal and the table row writes are for logins in the Admin workspace: any other login's key gets `403` with `reason: "member-login"` from them.

| Method and path                          | Area      | Does                                |
| ---------------------------------------- | --------- | ----------------------------------- |
| `GET /api/v1/whoami`                     | none      | Who the key acts as, and its scope  |
| `GET /api/v1/search?q=&ws=`              | Search    | Search the brain, across workspaces |
| `GET /api/v1/nodes/{id}`                 | All areas | Read any item by id                 |
| `GET`, `POST /api/v1/pages`              | Pages     | List, create                        |
| `GET`, `PATCH /api/v1/pages/{id}`        | Pages     | Read, change                        |
| `GET`, `POST /api/v1/notes`              | Notes     | List, create                        |
| `GET /api/v1/notes/{id}`                 | Notes     | Read                                |
| `GET`, `POST /api/v1/tasks`              | Tasks     | List, create                        |
| `GET`, `PATCH /api/v1/tasks/{id}`        | Tasks     | Read, change                        |
| `GET /api/v1/tables`                     | Tables    | List                                |
| `GET /api/v1/tables/{id}`                | Tables    | Read, with columns                  |
| `GET`, `POST /api/v1/tables/{id}/rows`   | Tables    | Read rows; add rows to the draft    |
| `PATCH /api/v1/tables/{id}/rows/{rowId}` | Tables    | Change one row in the draft         |
| `POST /api/v1/tables/{id}/commit`        | Tables    | Publish the draft                   |
| `GET`, `POST /api/v1/files`              | Files     | List, upload                        |
| `GET /api/v1/files/{id}`                 | Files     | File details                        |
| `GET /api/v1/files/{id}/download`        | Files     | The bytes                           |
| `GET`, `POST /api/v1/events`             | Calendar  | List, create                        |
| `GET /api/v1/contacts`, `/{id}`          | Contacts  | List, read                          |
| `GET`, `POST /api/v1/journal`            | Journal   | List, create                        |

A create (`POST` on pages, notes, tasks, files and events) takes `?ws=` with a workspace id, as in the app: the item lands in that workspace when the key's login may create there. Without it, the item lands where the app would put it.

Add rows with `{ "rows": [{ "Name": "Alpha" }] }`: each row is cells keyed by column name. Rows land on the table's draft. Commit to publish them.

## Search across workspaces

`GET /api/v1/search?q=` looks in every workspace the key's login reads. Each hit names the workspace it opens in, as `workspace: { id, name }`, one of the login's own workspaces. A hit that none of them reads has no `workspace`.

Add `ws=<workspace id>` to put the hits of that workspace first. It does not narrow the search. The answer echoes it as `ws`. A workspace the key's login is not a user of, or an id that is not a workspace, gets `404`.

```sh
curl -s "https://example.com/api/v1/search?q=invoice&ws=<workspace id>" \
  -H "Authorization: Bearer mtlk_..."
```

**System > API Console** shows example bodies for the routes Jackdaw uses ([API console](04-api-console.md)).

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
