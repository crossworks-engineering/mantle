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
  in `gateway_services` (migration 0358). A model never names a host. The
  gateway holds no database login: it reads the registry from the brain
  (`GET /api/gateway/registry`, its token) and keeps it five seconds. When
  the brain does not answer, every call is refused (503); an old copy is
  never served. A failed read is kept a moment (1 s, doubling to 10 s while
  it lasts) so the brain is not asked on every call, and its reason (a
  token mismatch included) is said in the gateway's log at most once a
  minute. Neither of the gateway's calls to the brain follows a redirect,
  and both go to a checked address: the brain's name is resolved and
  refused when it answers inside a services subnet (a service there could
  take the name `web` as an alias and catch the token).
- **A token.** The brain proves itself with `GATEWAY_TOKEN` in the
  `x-mantle-gateway-token` header. `Authorization` stays the service's
  own: the brain puts the service's vault key there at call time, as for
  any http tool. The gateway holds no service secret.
- **A call log.** One `gateway_calls` row per call that carried the token,
  refusals included: slug, method, path (no query string), status, bytes
  each way, duration, the caller (an agent, a surface, a connector) and its
  login. The gateway sends its rows to the brain in batches
  (`POST /api/gateway/calls`, its token), in the background: a call never
  waits on its row, and a batch the brain does not take is lost. A call
  without the token leaves no row (it is counted and said in the gateway's
  log at most every ten minutes), so nothing that reaches the gateway can
  grow the table or forge a caller. The brain removes rows past 90 days.
- **Only the brain can reach it.** It listens on its own address on the
  default network, and drops any request from a services subnet (in the
  request handler, before the token): a service never calls the gateway. An
  idle socket from such a subnet stays open until it sends a request and counts
  toward the connection limit: accepted, as it takes a compromised service and
  costs only availability. A
  second listener on the container's `127.0.0.1` answers `GET /healthz`
  and nothing else, for compose's health check. It never listens on every
  address: when `GATEWAY_UPSTREAM_CIDRS` does not match its networks (no
  address of its own inside it), it listens on `127.0.0.1` only, logs
  `not serving`, and every service call fails until the range is set
  right.
- **The brain's two gateway routes take only the gateway.** Each needs the
  gateway token, and a request that came through the front door (Caddy adds
  `X-Forwarded-For` to every request it passes on) is refused before the
  token is read. They take no rate limit: a limit per address would put
  every direct caller in one bucket, so a stranger without the token could
  use it up and starve the gateway; the token is 256 bits and a refusal
  does no work. A service on `mantle_services` cannot reach the brain at
  all: the brain is not on that network.

## A service row

| Field           | What it holds                                                                    |
| --------------- | -------------------------------------------------------------------------------- |
| `slug`          | the URL segment after `/svc/`: 1 to 40 lowercase letters, digits or dashes       |
| `upstream`      | `host:port`: the service's container name (one label, no dots) and its port      |
| `path_prefixes` | the paths below the slug it may be called on; a prefix matches on a segment edge |
| `methods`       | the methods it may be called with                                                |
| `reads_only`    | the owner's mark that it only reads: shown, never relied on                      |
| `enabled`       | the switch: off refuses every call within five seconds                           |

An upstream may not be an IP address, a dotted name (a public name could
answer any address), `localhost`, or one of the stack's own services
(`postgres`, `objectstore`, `web`, `api`, the workers and the rest). The
gateway also connects only to an address inside a `mantle_services` subnet:
it resolves the name and refuses any answer outside it, its own address,
the subnet's first host (the bridge, the Docker host) and the broadcast.
The subnet is fixed: compose gives `mantle_services` the range
`MANTLE_SERVICES_SUBNET` (default `172.31.250.0/24`) and hands the same
range to the gateway as `GATEWAY_UPSTREAM_CIDRS`. Before the network
exists, `install.sh` and the updater check the range against every Docker
network on the host: one that overlaps is swapped for a free /24
(`172.31.240-255.0/24`, then `10.250.240-255.0/24`), written to `.env` and
said in the log; with none free the install stops, and a roll is refused
with no container changed. With no range the gateway refuses every
service.

The first roll to this release is not covered by that check: the box's old
updater runs it, so `ensure_services_subnet` does not run until the next
roll. Before that first roll, check that no Docker network or host route
overlaps the range, and set `MANTLE_SERVICES_SUBNET` in `.env` if one does.

`reads_only` is a mark, not a rule: an MCP service reads over POST. A
service that must not write gets a read-only login of its own.

## Registering a service

An Admin user with the connectors area registers, edits and switches off a
service. The settings screen comes with phase 1b; until then:

- MCP: `gateway_service_set` and `gateway_service_list` (MCP only: no agent
  is granted them). The list shows the calls counted by service, status and
  refusal; paths and callers only with `call_detail: true` (a path can name
  a client record).
- HTTP: `GET` and `POST /api/gateway-services`, `GET` and
  `PATCH /api/gateway-services/<slug>`.

A write runs at the full-route spot `tool-config`: a row decides where calls
go, as a tool group's integration does.

## Calling a service

- **An http tool**: its URL is `${GATEWAY_URL}/svc/<slug>/...`, written out,
  for example `http://gateway:8097/svc/billing/query`. The slug must be literal
  in the URL the author wrote. A model-filled `{param}` may fill the path
  below it but never choose the service: a request whose resolved URL names
  another slug is refused before it is sent. The URL may carry no
  `{{secret:...}}` (the gateway logs the path): the service's key goes in a
  header. A path may carry plain printable ASCII and the percent codes of
  plain characters (`%20`, `%3A`, `%40` and the like); anything else (an
  encoded `/`, `\`, `.`, `;` or `%`, any byte past ASCII) is refused by the
  gateway, so pass such a value in the query string. The brain sets the
  caller and login headers itself, removing any the tool wrote.
- **An MCP connector**: its URL is `http://gateway:8097/svc/<slug>/mcp`
  (whatever path the service serves). Every request of the connector must
  stay on that slug.

The brain adds the gateway headers only on these two paths. `web_fetch`
reaches the gateway's address (the carve is the egress guard's) but carries
no token, so the gateway answers 401.

Every hop of a call that starts at a service stays on it: a redirect out of
the gateway, or to another service on it, is refused. No hop may enter the
gateway from anywhere else.

## Who may call a service

Any http tool or MCP connector whose URL names a registered service may call
it, including a tool an assistant wrote (the Toolsmith's `api_tool_create`).
Registering a service is an Admin's alone, but calling one is not narrowed
further yet. This is accepted for phase 1a, while no box runs a registered
service. Before a client database goes behind the gateway (phase 2), each
service gets a list of the tools and connectors allowed to call it, set by an
Admin only. Until then, a box that registers a service can turn on Toolsmith
approval, so a tool an assistant writes waits for a person.

## What the gateway refuses

| Status | Code                   | When                                                                                                            |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`         | no token, or the wrong one                                                                                      |
| 503    | `no_token`             | the box has no `GATEWAY_TOKEN` yet                                                                              |
| 404    | `not_found`            | a path outside `/svc/`                                                                                          |
| 404    | `unknown_service`      | no service has the slug                                                                                         |
| 403    | `service_disabled`     | the service is off, or its row names an upstream it may not                                                     |
| 405    | `method_not_allowed`   | the method is not in the row                                                                                    |
| 403    | `path_not_allowed`     | the path is under none of the row's prefixes                                                                    |
| 400    | `bad_path`             | a `.`, `..` or empty segment, a `\` or `;`, a byte past ASCII, a percent code of anything but a plain character |
| 503    | `registry_unavailable` | the brain did not hand over the registry (stopped, or the token is wrong)                                       |
| 502    | `gateway_error`        | any other fault of the gateway's own                                                                            |
| 502    | `upstream_refused`     | the upstream name resolves outside `mantle_services`                                                            |
| 502    | `upstream_unreachable` | the service did not answer                                                                                      |
| 504    | `upstream_timeout`     | the service went quiet past `GATEWAY_UPSTREAM_IDLE_MS`                                                          |
| 413    | `too_large`            | the body is over `GATEWAY_MAX_BODY_BYTES`                                                                       |

The gateway answers `GET /healthz` without a token (`{ "ok": true }`). It
carries plain HTTP only: an upgrade (a WebSocket) is closed. It drops
the method-override headers (`X-HTTP-Method-Override`, `X-HTTP-Method`,
`X-Method-Override`), so a service cannot be made to run a method by a
header. The allowed methods are what the gateway sees: a service that
honours a `_method` query or form field decides for itself, so do not
allow POST to a service that does that unless its other methods are safe
too. It holds at most 256 connections, and a request must arrive whole
within five minutes.

## A box service

A service's own compose file joins the network by its fixed name. Do not
name the service after one of the stack's own (`web`, `api`, `postgres`
and the rest): the name becomes its address on `mantle_services`, and a
service named `web` makes the gateway refuse every call (it will not send
its token to an address on the services network).

```yaml
services:
  billing-agent:
    image: example/billing-agent:1.0.0
    networks: [mantle_services]
networks:
  mantle_services:
    external: true
```

Then register it with `upstream: billing-agent:8080` and the paths and
methods it serves.

## Settings

| Variable                   | Default               | What it decides                                        |
| -------------------------- | --------------------- | ------------------------------------------------------ |
| `GATEWAY_URL`              | `http://gateway:8097` | where the brain reaches the gateway (the carve)        |
| `GATEWAY_TOKEN`            | none                  | the bearer; install.sh writes it, a roll provisions it |
| `GATEWAY_PORT`             | 8097                  | where the gateway listens                              |
| `MANTLE_SERVICES_SUBNET`   | `172.31.250.0/24`     | `mantle_services`' fixed range (compose)               |
| `GATEWAY_UPSTREAM_CIDRS`   | the range above       | the services range the gateway connects inside         |
| `GATEWAY_BRAIN_URL`        | `http://web:3000`     | the brain it reads its registry from and logs to       |
| `GATEWAY_MAX_BODY_BYTES`   | 64 MB                 | the largest request body                               |
| `GATEWAY_UPSTREAM_IDLE_MS` | 120000                | an idle upstream connection is cut                     |
| `GATEWAY_MEM_LIMIT`        | `256m`                | the container's memory (compose)                       |

The gateway runs on Bun (`scripts/run-service.sh`).
It holds no database login and no service key: its environment is its
token, the brain's address and the services range.

## Code

- `server/gateway/src/route.ts`: the decision, no I/O.
- `server/gateway/src/upstream.ts`: the services range and the address check.
- `server/gateway/src/brain.ts`: the registry read and the call batches.
- `server/gateway/src/server.ts`: the HTTP server and the proxy.
- `packages/db/src/service-gateway-rules.ts`: what a service row may hold.
- `packages/db/src/service-gateway.ts` and `service-gateway-calls.ts`: the
  registry's reads and writes, and the call log.
- `server/web/lib/gateway-internal.ts` and `app/api/gateway/*`: the
  gateway's own two routes on the brain.
- `packages/tools/src/ssrf-guard.ts`: the carve and `hopGuard`.
- `packages/tools/src/gateway.ts`: the headers and the slug binding.
