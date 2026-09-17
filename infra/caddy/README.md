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
