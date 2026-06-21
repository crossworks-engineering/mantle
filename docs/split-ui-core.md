# Split UI / core over Tailscale

Mantle normally runs as one stack on one host: the **core** (Postgres, object
store, the always-on workers/agent) and the **app/UI** (the Next web server) side
by side. But they don't have to live together. With the bundled Tailscale node
serving the core onto your tailnet, you can run the **UI/app layer as a separate
client** — a dev server on your laptop, a native Electron desktop build, another
device — while the **core stays on the server**, reachable by a stable MagicDNS
name and nothing else.

This is the same feature that powers [developing against a remote
database](./remote-db-dev.md); this doc is the architecture behind it, and what
else it unlocks.

## Core vs. app layer

| | What it is | Where it runs |
|---|---|---|
| **Core (the brain)** | Postgres (the graph + vault) · object store (MinIO/S3, the file bytes) · always-on workers (extractor, summarizer, reflector, document) + agent | The server — one durable home for the data + indexing |
| **App / UI layer** | The Next app and its tool loop (web `/assistant`, settings, pages, tables) — stateless over the core | Anywhere on the tailnet: a laptop dev server today, an Electron desktop build tomorrow, multiple devices |

The app layer holds no durable state of its own — it reads and writes the core.
So you can run **N app clients against one core** without coordination: the
server's workers keep indexing in the background while a laptop or desktop client
drives conversations and edits against the same brain.

## What makes it possible: Tailscale, both directions

The [bundled Tailscale node](./tailscale.md) is a private, encrypted mesh between
your machines. Mantle uses it **two ways**:

```
            ┌──────────────────────── your tailnet (WireGuard) ───────────────────────┐
            │                                                                          │
  OUTBOUND  │   core ──HTTP/SOCKS proxy──▶ gpu-box:11434        (reach inference)      │
  (existing)│                                                                          │
            │                                                                          │
  INBOUND   │   laptop / Electron / phone ──▶ mantle.<tailnet>.ts.net:5432  (Postgres) │
  (new)     │                              └▶ mantle.<tailnet>.ts.net:9000  (object)   │
            │                                                                          │
            └──────────────────────────────────────────────────────────────────────────┘
                                   core = Postgres + MinIO + workers (on the server)
```

- **Outbound** (already shipped): the core proxies *out* to a model box you own,
  so capable local models stay on your hardware — see [tailscale.md](./tailscale.md).
- **Inbound** (this): the core *serves* its data plane onto the tailnet with
  `tailscale serve --tcp`, so app clients reach Postgres + the object store by
  MagicDNS. No port-forwarding, no public exposure, encrypted end to end.

Crucially the core's Tailscale runs in **userspace** mode (it can't be a subnet
router), so `serve` is exactly the right primitive: it forwards two specific TCP
ports to two specific containers, and nothing else.

## What gets served — and why both

Two ports, published tailnet-only:

- **Postgres `:5432`** — the graph, conversations, and the encrypted vault.
- **Object store `:9000`** — the file/image bytes (S3 API).

**Serve both or neither.** A file node's row lives in Postgres but its bytes live
in the object store. Point a client at the remote DB but a *local* object store
and every upload writes a row that references bytes nobody else has — a dangling
file node in the core, and remote files that 404 on the client. Splitting at the
data layer means splitting the *whole* data layer.

The encryption master key (`MANTLE_MASTER_KEY`) must match the core's on every
client, so the encrypted vault rows decrypt. Nothing else is shared.

## Use cases this unlocks

1. **Develop against real data** — run `pnpm -C apps/web dev` on your laptop
   against the live core, no local replica. The [remote-db-dev](./remote-db-dev.md)
   workflow.
2. **A native desktop app** — an Electron build is just another app-layer client:
   it talks to `mantle.<tailnet>.ts.net` for DB + object store and renders a native
   UI, while the server keeps doing the heavy, always-on indexing.
3. **Many devices, one brain** — a laptop and a desktop can both run the app layer
   against the same core; the brain is shared, the UI is wherever you are.

## Setup (summary)

On the **core** (one-time, re-run after a redeploy — see caveat):

```sh
pnpm tailscale:serve          # publishes :5432 + :9000 on the tailnet
pnpm tailscale:serve:status
```

On each **client**: join the same tailnet, then point `apps/web/.env.local` at the
MagicDNS name (`DATABASE_URL=…@mantle.<tailnet>.ts.net:5432`,
`S3_ENDPOINT=http://mantle.<tailnet>.ts.net:9000`) with the core's credentials.
Full steps + the SSH-tunnel fallback: [remote-db-dev.md](./remote-db-dev.md).

## Security model

- **Tailnet-only.** `serve` (not `funnel`) exposes the ports to your tailnet, never
  the public internet. Traffic is WireGuard-encrypted device-to-device.
- **Standing exposure.** Once served, the DB + object store are reachable by *every*
  device on your tailnet — scope with [tailnet ACLs](https://tailscale.com/kb/1018/acls)
  if it's more than your own machines. Remove the exposure with
  `scripts/prod-tailscale-serve.sh reset`.
- **Live data.** App clients write to the live core — including a migration run from
  a client. Back up first ([backups.md](./backups.md)).
- **Vault.** Encrypted rows only decrypt where `MANTLE_MASTER_KEY` matches; the key
  is never served.

## Ports & firewall — nothing to open

This is a big part of the appeal: the tailnet path opens **no inbound ports** on
the core's host.

- **Postgres `:5432` and object store `:9000` are never bound to the host's public
  interface** — they live on the docker bridge and are reached *only* over the
  tailnet (WireGuard). On the reference deployment the host's only public
  listeners are **80/443** (the web app via Caddy) and **22** (SSH); `5432`/`9000`
  publish no host ports at all.
- **Tailscale needs only *outbound* connectivity** — UDP **41641** for direct
  peer-to-peer, falling back to **DERP relays over TCP 443** if that's blocked. So
  it traverses strict NAT/firewalls with nothing forwarded (we've seen the core
  reachable "via DERP" with zero host ports opened).
- **SSH-tunnel fallback** uses TCP **22**, already open for admin — no new ports.

Contrast with the naïve alternative: exposing the data plane *without* Tailscale
would mean publishing `5432`/`9000` on the public internet — which you should never
do for a database. Tailscale gives you the remote reach without the open port.

## Caveats

- **Re-serve after a redeploy.** `tailscale serve` targets container IPs, which
  change when containers are recreated — re-run `pnpm tailscale:serve` if the
  tailnet endpoints go quiet. (`scripts/prod-tailscale-serve.sh` re-resolves them.)
- **The split is at the data layer.** The app layer still bundles the Next server +
  tool loop; this isn't a thin web client talking to a remote API, it's the app
  running locally against a remote core. (Serving the web app itself over the
  tailnet is a separate, future option.)
- **Workers still run on the server.** The always-on indexing pipeline lives with
  the core; a client doesn't need to run it (though in dev you can run individual
  workers locally against the remote core too).
