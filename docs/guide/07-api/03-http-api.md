# The HTTP API

Mantle's HTTP API is the set of `/api/` routes that Jackdaw itself calls. You can call them too, but they are not a versioned public contract: a route can change with any release. For scripts and AI clients, use MCP ([Connect Claude over MCP](01-connect-claude.md)). Its tools are the stable surface.

## Get a token

Exchange a login's email and password for a bearer token:

```sh
curl -s https://example.com/api/auth/token \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password","deviceName":"my script"}'
```

The reply holds `token` and `expiresAt`. A token lasts 30 days.

## Call a route

Send the token in the `Authorization` header:

```sh
curl -s https://example.com/api/auth/whoami \
  -H "Authorization: Bearer $TOKEN"
```

`whoami` answers with the login's role, email and name. Admin routes refuse member and client logins with a 403.

## Find the routes

Open **System > API Console** in Jackdaw. Its **Built-in API** list shows every route with an example body, and you can run each one there ([API console](04-api-console.md)).

## Manage tokens

- Each token shows as a device under **Settings > Logins > Devices**. Revoke it there.
- A password change or "sign out everywhere" ends every token for that login.
- Sign-in is limited to 10 tries a minute per address.

## Calling from a browser on another origin

A web page on another origin needs its origin listed in `MANTLE_API_CORS_ORIGINS` ([Environment variables](../05-admin/03-env-vars.md)).

## Next

- [API console](04-api-console.md)
- [Connect Claude over MCP](01-connect-claude.md)
