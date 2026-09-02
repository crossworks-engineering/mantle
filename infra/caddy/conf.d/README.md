# Caddy drop-ins

Box-local routes that must survive a release roll. The shipped Caddyfile
imports `/etc/caddy/conf.d/*.caddy` INSIDE its site block, and compose mounts
this folder there read-only. One file per concern, named for what it serves.

Why: the Caddyfile is release-owned. Editing it on a box worked until the next
release replaced it, and the route was gone. A drop-in is never touched by a
roll.

Rules:

- Only `handle`, `handle_path`, `redir`, `header` and friends that are valid
  inside a site block. No site addresses here; a second vhost is a different
  Caddyfile.
- Caddy orders `handle` blocks by path length, so `handle /pcms-mcp/*` wins
  over the catch-all regardless of import position.
- Secrets never go in a drop-in. Put the bearer check in the upstream, or use
  Caddy's `{$ENV}` placeholders with the value in `.env`.
- `*.caddy` files are gitignored: they are box-local by definition and this
  repo is public.

Apply a new or changed drop-in with `docker restart mantle_caddy` (the folder
is a bind mount; caddy re-reads it on start). Check with:

```sh
docker exec mantle_caddy caddy validate --config /etc/caddy/Caddyfile
```

Example, an MCP bridge on the internal network behind a public path:

```caddyfile
handle /pcms-mcp/* {
	reverse_proxy pcms-mcp:8000
}
```
