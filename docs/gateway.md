# The service gateway

One small service, `gateway` (`server/gateway`), is the only internal door
from the brain to the services of its box: a client database's query face,
an MCP bridge, any service a box runs beside the brain. It is phase 1a of
the Data sources plan.

Without it, every box service needs a public Caddy route, because the
egress guard (`packages/tools/src/ssrf-guard.ts`) refuses every private
address, by design.

## The shape

- **Two networks.** The gateway joins the default network (the brain
  reaches it at `GATEWAY_URL`, `http://gateway:8097` in compose) and the
  internal network `mantle_services` (`internal: true`: no road out).
  A box service joins `mantle_services` only. Nothing on it publishes a
  port or has a Caddy route.
- **One egress carve.** `isGatewayUrl`: the origin must equal
  `GATEWAY_URL`'s exactly, and the path must be `/svc/<slug>`. Every other
  private address stays refused, the service's own address included.
- **A registry.** The gateway routes `/svc/<slug>/<path>` only to a service
  in `gateway_services` (migration 0358). A model never names a host.
- **A token.** The brain proves itself with `GATEWAY_TOKEN` in the
  `x-mantle-gateway-token` header. `Authorization` stays the service's
  own: the brain puts the service's vault key there at call time, as for
  any http tool. The gateway holds no service secret.
- **A call log.** One `gateway_calls` row per call, refusals included:
  slug, method, path (no query string), status, bytes each way, duration,
  the caller (an agent, a surface, a connector) and its login. The gateway
  removes rows past 90 days itself.

## A service row

| Field           | What it holds                                                                    |
| --------------- | -------------------------------------------------------------------------------- |
| `slug`          | the URL segment after `/svc/`: 1 to 40 lowercase letters, digits or dashes       |
| `upstream`      | `host:port`: the service's own DNS name on `mantle_services` and its port        |
| `path_prefixes` | the paths below the slug it may be called on; a prefix matches on a segment edge |
| `methods`       | the methods it may be called with                                                |
| `reads_only`    | the owner's mark that it only reads: shown, never relied on                      |
| `enabled`       | the switch: off refuses every call at once                                       |

An upstream may not be an IP address, `localhost`, or one of the stack's
own services (`postgres`, `objectstore`, `web`, `api`, the workers and the
rest). The gateway also connects only to an address inside a
`mantle_services` subnet: it resolves the name and refuses any answer
outside it. It finds that subnet at start from its own interfaces (every
subnet but the one that holds the database host), or from
`GATEWAY_UPSTREAM_CIDRS` when it runs outside compose. With no subnet found
it refuses every service.

`reads_only` is a mark, not a rule: an MCP service reads over POST. A
service that must not write gets a read-only login of its own.

## Registering a service

An Admin user with the connectors area registers, edits and switches off a
service. The settings screen comes with phase 1b; until then:

- MCP: `gateway_service_set` and `gateway_service_list` (MCP only: no agent
  is granted them).
- HTTP: `GET` and `POST /api/gateway-services`, `GET` and
  `PATCH /api/gateway-services/<slug>`.

A write runs at the full-route spot `tool-config`: a row decides where calls
go, as a tool group's integration does.

## Calling a service

- **An http tool**: its URL is `${GATEWAY_URL}/svc/<slug>/...`, written out,
  for example `http://gateway:8097/svc/pcms/query`. The slug must be literal
  in the URL the author wrote. A model-filled `{param}` may fill the path
  below it but never choose the service: a request whose resolved URL names
  another slug is refused before it is sent.
- **An MCP connector**: its URL is `http://gateway:8097/svc/<slug>/mcp`
  (whatever path the service serves). Every request of the connector must
  stay on that slug.

The brain adds the gateway headers only on these two paths. `web_fetch`
reaches the gateway's address (the carve is the egress guard's) but carries
no token, so the gateway answers 401.

Every hop of a call that starts at a service stays on it: a redirect out of
the gateway, or to another service on it, is refused. No hop may enter the
gateway from anywhere else.

## What the gateway refuses

| Status | Code                   | When                                                            |
| ------ | ---------------------- | --------------------------------------------------------------- |
| 401    | `unauthorized`         | no token, or the wrong one                                      |
| 503    | `no_token`             | the box has no `GATEWAY_TOKEN` yet                              |
| 404    | `not_found`            | a path outside `/svc/`                                          |
| 404    | `unknown_service`      | no service has the slug                                         |
| 403    | `service_disabled`     | the service is off, or its row names an upstream it may not     |
| 405    | `method_not_allowed`   | the method is not in the row                                    |
| 403    | `path_not_allowed`     | the path is under none of the row's prefixes                    |
| 400    | `bad_path`             | a `.`, `..` or empty segment, a `\`, an encoded `/`, `\` or `.` |
| 502    | `upstream_refused`     | the upstream name resolves outside `mantle_services`            |
| 502    | `upstream_unreachable` | the service did not answer                                      |
| 504    | `upstream_timeout`     | the service went quiet past `GATEWAY_UPSTREAM_IDLE_MS`          |
| 413    | `too_large`            | the body is over `GATEWAY_MAX_BODY_BYTES`                       |

The gateway answers `GET /healthz` without a token. It carries plain HTTP
only: an upgrade (a WebSocket) is closed.

## A box service

A service's own compose file joins the network by its fixed name:

```yaml
services:
  pcms-agent:
    image: example/pcms-agent:1.0.0
    networks: [mantle_services]
networks:
  mantle_services:
    external: true
```

Then register it with `upstream: pcms-agent:8080` and the paths and
methods it serves.

## Settings

| Variable                   | Default               | What it decides                                        |
| -------------------------- | --------------------- | ------------------------------------------------------ |
| `GATEWAY_URL`              | `http://gateway:8097` | where the brain reaches the gateway (the carve)        |
| `GATEWAY_TOKEN`            | none                  | the bearer; install.sh writes it, a roll provisions it |
| `GATEWAY_PORT`             | 8097                  | where the gateway listens                              |
| `GATEWAY_UPSTREAM_CIDRS`   | found at start        | the services subnets, outside compose                  |
| `GATEWAY_MAX_BODY_BYTES`   | 64 MB                 | the largest request body                               |
| `GATEWAY_UPSTREAM_IDLE_MS` | 120000                | an idle upstream connection is cut                     |
| `GATEWAY_MEM_LIMIT`        | `256m`                | the container's memory (compose)                       |

The gateway runs on Bun or Node (`MANTLE_RUNTIME`, `scripts/run-service.sh`).
Its environment is the least it needs: the database (the registry and the
call log, as the runtime role on a box that runs it) and its token.

## Code

- `server/gateway/src/route.ts`: the decision, no I/O.
- `server/gateway/src/upstream.ts`: the services subnet and the address check.
- `server/gateway/src/server.ts`: the HTTP server and the proxy.
- `packages/db/src/service-gateway.ts`: the registry's rules, reads, writes
  and the call log.
- `packages/tools/src/ssrf-guard.ts`: the carve and `hopGuard`.
- `packages/tools/src/gateway.ts`: the headers and the slug binding.
