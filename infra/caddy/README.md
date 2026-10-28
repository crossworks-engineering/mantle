# infra/caddy: the front door

One release-owned `Caddyfile` for every box. What varies per box comes from
the environment or from drop-in files, never from editing the Caddyfile.

| piece                | what                                                                  | who owns it                                     |
| -------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `Caddyfile`          | the site block(s): TLS, access log, body cap, the two imports below   | the release (refreshed by the updater)          |
| `shapes/*.caddy`     | how the two apps share the domain: `same-origin` (default) or `split` | the release (refreshed by the updater)          |
| `conf.d/*.caddy`     | routes a box needs beyond the release                                 | the box (gitignored, never touched by a roll)   |
| `MANTLE_CADDY_SHAPE` | picks the shape file, `.env`                                          | the box (install.sh writes it; default is fine) |

The Caddyfile imports `shapes/{$MANTLE_CADDY_SHAPE:same-origin}.caddy` and
`conf.d/*.caddy` inside its main site block. Compose mounts all three paths
read-only into `mantle_caddy`.

## HTTPS only (HSTS)

Both site blocks send `Strict-Transport-Security: max-age=31536000` on TLS
responses. After one HTTPS visit a browser goes straight to HTTPS for that
host, so a bare hostname still opens where port 80 is closed at the cloud
edge (the plain-http request never reaches the redirect). Plain-HTTP
responses (`:80` local testing) carry no header. One year, this host only:
no `includeSubDomains`, no `preload`. Opening port 80 at the edge is still
the right fix for a first visit; the header covers every visit after it.

## Refresh and drift

The updater sidecar (`infra/updater/updater.sh`) treats the Caddyfile and the
shapes like `docker-compose.yml`: on a roll it extracts the release's copy
from the target image and swaps it in when the box copy is byte-identical to
its `.release` baseline. A locally edited copy is left alone, logged loudly,
and shown as drift on `/settings/updates` and in `pnpm status`. When a refresh
lands, caddy is recreated so the new file is really read (a bind mount keeps
the old inode until then).

First-time adoption on an existing box, or after a hand edit you want to drop:

```sh
cd <stack dir> && scripts/compose-adopt.sh --apply   # seeds Caddyfile + shapes + baselines
docker compose up -d --no-deps --force-recreate caddy
```

Validate any change before trusting it:

```sh
docker exec mantle_caddy caddy validate --config /etc/caddy/Caddyfile
```

## Why

Every Caddyfile change used to be a hand copy per box, then a caddy restart
someone had to remember. Boxes drifted (one carried its own comment header),
and a route added by hand for a client integration would have been wiped by
the next roll. Now the file is the same everywhere, the shape is a switch, and
the routes a box adds live where a roll cannot reach them.

## Calls (LiveKit) route: P1 draft from the P0 spike

Not in the Caddyfile yet. The spike ran these lines from a box-local drop-in;
P1 M2 moves them into the release file (both shapes, before the catch-all)
and grows the access-log filter, because a drop-in cannot change the release
logger and the signalling URL carries the join token as a query parameter.

```
# Calls signalling. The browser connects to wss://<site>/livekit (the JS
# client appends /rtc itself); handle_path strips the prefix and Caddy
# proxies the WebSocket upgrade as is. Media never passes through Caddy.
# handle_path /livekit/* {
# 	reverse_proxy livekit:7880
# }
#
# In the log filter, extend the uri regexp so the token is redacted like
# the sign-in code is today (one alternation more, one group more):
# request>uri regexp "(^/api/auth/invite/)[A-Za-z0-9]{16}|([?&]code=)[^&#]*|([?&]access_token=)[^&#]*" "${1}${2}${3}REDACTED"
```

Spike evidence (2026-10-28): the release logger printed the full JWT in
`"uri":"/livekit/rtc?access_token=eyJ..."` for every signalling request; a
second, named `log` directive in the drop-in printed the same requests with
`access_token=REDACTED` but doubled every access-log line, so it is not the
fix. The `join_request=` parameter next to the token is the client's
protobuf join request (client info, connection settings), not a secret.
