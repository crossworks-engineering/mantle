# MCP connectors: external MCP servers as tool groups

Point Mantle at an external MCP server and its tools become a normal
per-connector **tool group** any agent can be granted. The plan that shaped
this: [`docs/plans/mcp-connectors.md`](./plans/mcp-connectors.md). Phase 1
(this doc): streamable-HTTP servers with a static key from the vault. OAuth
servers and the settings UI are later phases.

## The model — no new entities

A connector **IS** a `tool_groups` row (slug `mcp-<connector>`), extended:

- `integration.mcp` carries the binding: `{ url, secretRef?, authHeader?,
authScheme?, lastSyncAt, toolCount, serverInfo }`. `secretRef` is a
  `service/label` pointer into the `api_keys` vault — a plaintext credential
  never lands on the row. Validated by `parseMcpBinding`
  (`packages/tools/src/integration-meta.ts`).
- Each remote tool is an ordinary `tools` row with `handler = { kind: 'mcp',
group, toolName }` and slug `mcp_<connector>_<tool>`. It flows through the
  same resolve → allowlist → confirm → dispatch pipeline as every other tool.
- Grants, `/settings/tool-groups`, traces, and the tool loop need zero new
  machinery. The system manifest never prunes operator-created groups, and
  the `mcp-` prefix guarantees no manifest-slug collision.

## Sync — explicit, never scheduled

`syncMcpConnector` (in `packages/tools/src/mcp-sync.ts`) connects, lists the
server's tools, and reconciles rows: insert new, update changed (identity is
the remote `toolName`, so a rename of our slug convention can't fork rows),
**disable** vanished (never delete — deleting would silently shrink grants),
re-enable returners, then rewrite the group's `toolSlugs` to the live set.
Runs on create and on demand (`POST /api/mcp-connectors/<slug>/sync`). Never
on a cron — cost-safety rule.

## Guardrails

- **Untrusted, always.** Every result returns `untrusted: true` → the tool
  loop fences it as data before the model reads it, same as `web_fetch`.
  Result text is capped at 80k chars before the normal inline/spill caps.
- **Egress.** `assertFetchableUrl` runs on the connector URL and on every
  request the transport makes; redirects are refused outright (a redirect
  would carry the auth header to another host). Consequence: a **loopback /
  private-network MCP server is not reachable** — connectors are for
  external servers by definition.
- **Secrets.** The credential resolves at connect time; `scrubSecrets` runs
  over result text AND error messages, so an echoing endpoint can't leak the
  key to the model.
- **Grants.** Connector groups are granted to no one by default. The
  generated group description recommends the researcher-firewall pattern
  (no-write specialist), never the persona/team responder. Agents may
  _request_ a grant (`agent_grant_tool_group` — still parked for operator
  approval) but can never _bundle_ mcp tools into other groups
  (`tool_group_ensure` refuses; sync owns membership) and can't patch a
  connector tool's definition (`api_tool_update` refuses).
- **Timeouts.** 25 s per call / 15 s connect; the client is a lazy
  per-connector singleton with 5-minute idle teardown and respawn-once
  recovery (`packages/tools/src/mcp-client.ts`).

## API (owner-gated)

| Route                                         | Does                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mcp-connectors`                     | Connected servers + the `KNOWN_MCP_SERVERS` catalog (placeholder rows, `connected` flags)                                                                                                 |
| `POST /api/mcp-connectors`                    | `{ slug, url, secretRef?, authHeader?, authScheme?, name? }` → creates `mcp-<slug>` + first sync. A failed first sync keeps the group (`syncError` in the response) — fix config, resync. |
| `GET/PATCH/DELETE /api/mcp-connectors/<slug>` | Inspect / edit binding (bounces the cached client) / delete (rows + group + grants)                                                                                                       |
| `POST /api/mcp-connectors/<slug>/sync`        | Re-list + reconcile                                                                                                                                                                       |

## The catalog

`KNOWN_MCP_SERVERS` (`packages/tools/src/mcp-catalog.ts`) is the
`KNOWN_KEY_SERVICES` twin: server-driven placeholder rows with `whenToUse`
prose that lands in the generated group description — that's where
"call this vs the built-ins" judgment lives. The Firecrawl entry marks the
boundary explicitly: `web_map`/`web_crawl` own crawl-and-ingest;
the connector is for ad-hoc scrape/search/extract into context.
Pre-known services are **not** auto-provisioned.

## Firecrawl quick start (key-authed, works today)

1. Store the key: Settings → API keys, service `firecrawl`, label `default`.
2. `POST /api/mcp-connectors` with
   `{ "slug": "firecrawl", "url": "https://mcp.firecrawl.dev/v2/mcp",
"secretRef": "firecrawl/default" }`.
3. Grant `mcp-firecrawl` to the researcher (or another no-write specialist).

The `/v2/mcp-oauth` endpoint needs the Phase 2 OAuth client — not yet wired.

## Deferred

stdio transports (sandbox infra only, never the web process), MCP
resources/prompts, OAuth 2.1 client flow, the jackdaw
`/settings/connectors` screen.
