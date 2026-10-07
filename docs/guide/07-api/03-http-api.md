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

The routes past `whoami` are admin routes. A member's or client's key gets `403` from them and uses MCP instead.

| Method and path | Area | Does |
| --- | --- | --- |
| `GET /api/v1/whoami` | none | Who the key acts as, and its scope |
| `GET /api/v1/search?q=` | Search | Search the brain |
| `GET /api/v1/nodes/{id}` | All areas | Read any item by id |
| `GET`, `POST /api/v1/pages` | Pages | List, create |
| `GET`, `PATCH /api/v1/pages/{id}` | Pages | Read, change |
| `GET`, `POST /api/v1/notes` | Notes | List, create |
| `GET /api/v1/notes/{id}` | Notes | Read |
| `GET`, `POST /api/v1/tasks` | Tasks | List, create |
| `GET`, `PATCH /api/v1/tasks/{id}` | Tasks | Read, change |
| `POST /api/v1/tasks/{id}/comments` | Tasks | Comment, body `{ "body": "..." }` |
| `GET /api/v1/tables` | Tables | List |
| `GET /api/v1/tables/{id}` | Tables | Read, with columns |
| `GET`, `POST /api/v1/tables/{id}/rows` | Tables | Read rows; add rows to the draft |
| `PATCH /api/v1/tables/{id}/rows/{rowId}` | Tables | Change one row in the draft |
| `POST /api/v1/tables/{id}/commit` | Tables | Publish the draft |
| `GET`, `POST /api/v1/files` | Files | List, upload |
| `GET /api/v1/files/{id}` | Files | File details |
| `GET /api/v1/files/{id}/download` | Files | The bytes |
| `GET`, `POST /api/v1/events` | Calendar | List, create |
| `GET /api/v1/contacts`, `/{id}` | Contacts | List, read |
| `GET`, `POST /api/v1/journal` | Journal | List, create |

Add rows with `{ "rows": [{ "Name": "Alpha" }] }`: each row is cells keyed by column name. Rows land on the table's draft. Commit to publish them.

**System > API Console** shows example bodies for the routes Jackdaw uses ([API console](04-api-console.md)).

## Errors

| Status | Meaning |
| --- | --- |
| `401` | No key, a wrong key, or a revoked or expired one |
| `403` with `reason: "key-read-only"` | A read only key tried to write |
| `403` with `reason: "key-area"` | The route is outside the key's areas |
| `403` with `reason: "member-login"` or `"client-login"` | An admin route, and the key is not an admin's |
| `404` | Not a `/api/v1` route, or no such item |
| `429` | Too many requests; wait for `Retry-After` seconds |

## Calling from a browser on another origin

A web page on another origin needs its origin listed in `MANTLE_API_CORS_ORIGINS` ([Environment variables](../05-admin/03-env-vars.md)).

## Next

- [API keys](08-api-keys.md)
- [API console](04-api-console.md)
- [Connect Claude over MCP](01-connect-claude.md)
