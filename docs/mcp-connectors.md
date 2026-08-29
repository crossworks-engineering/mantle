# MCP connectors: external MCP servers as tool groups

Point Mantle at an external MCP server and its tools become a normal
per-connector **tool group** any agent can be granted. The plan that shaped
this: [`docs/plans/mcp-connectors.md`](./plans/mcp-connectors.md).
Streamable-HTTP servers only, with either a static key from the vault or the
full MCP OAuth flow. The settings UI is the remaining (jackdaw) phase.

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
  key to the model. The `mcp-` vault namespace (where OAuth state is sealed)
  is RESERVED: those rows never appear in `api_key_refs` or the keys API, a
  `{{secret:mcp-…}}` template ref is refused at dispatch, and a binding's
  `secret_ref` may not point into it — a prompt-injected author cannot ship a
  connector's live token anywhere.
- **Grants.** Connector groups are granted to no one by default. The
  generated group description recommends the researcher-firewall pattern
  (no-write specialist), never the persona/team responder. Agents may
  _request_ a grant (`agent_grant_tool_group` — still parked for operator
  approval) but can never _bundle_ mcp tools into other groups, edit or
  squat a connector group (`tool_group_ensure` refuses both the `mcp-`
  namespace and any group carrying the binding), wrap a connector tool in a
  recipe (the recipe safety envelope refuses — a recipe is bundleable
  anywhere, which would tunnel external content past the firewall), or
  patch/delete/hand-create a connector tool row (the crud layer refuses all
  three; the sync owns the rows). Granting a connector group to a delegate
  also teaches the parent: the live delegate roster inside `invoke_agent`
  names the group under that delegate on the parent's next turn, using the
  brain-authored group name + description only, never the mirrored tools'
  own text (see `docs/tools-and-skills.md`, delegate roster section).
- **Ownership boundaries.** The generic tool-group surface cooperates:
  deleting a connector group through `DELETE /api/tool-groups/[id]`
  delegates to the connector-aware delete (rows + grants + sealed secrets),
  and its PATCH refuses `toolSlugs`/binding edits on connector groups.
  Sync-vs-owner disable is asymmetric: the sync marks its own disables
  (`handler.vanishedAt`) and only re-enables those — a tool the OWNER
  disabled stays off and drops out of the group's membership until
  re-enabled by hand.
- **Remote schemas.** A tool's `inputSchema` arrives verbatim from the
  server (capped; oversized ones fall back to an open object). The central
  arg validator applies its usual JSON-Schema subset to model input; unknown
  constructs (`$ref`, `anyOf`, …) pass through and the remote server remains
  the final validator of its own arguments.
- **Timeouts.** 25 s per call / 15 s connect; the client is a lazy
  per-connector singleton with 5-minute idle teardown and respawn-once
  recovery (`packages/tools/src/mcp-client.ts`). The OPTIONAL standalone GET
  notification stream gets a 5 s time-to-headers bound: a server that accepts
  the GET and never answers (DeepWiki does this) would otherwise wedge every
  queued tool call behind the dead request; timing it out degrades to
  "server doesn't push", which the spec allows.

## API (owner-gated)

| Route                                         | Does                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mcp-connectors`                     | Connected servers + the `KNOWN_MCP_SERVERS` catalog (placeholder rows, `connected` flags)                                                                                                 |
| `POST /api/mcp-connectors`                    | `{ slug, url, secretRef?, authHeader?, authScheme?, name? }` → creates `mcp-<slug>` + first sync. A failed first sync keeps the group (`syncError` in the response) — fix config, resync. |
| `GET/PATCH/DELETE /api/mcp-connectors/<slug>` | Inspect / edit binding (bounces the cached client) / delete (rows + group + grants)                                                                                                       |
| `POST /api/mcp-connectors/<slug>/sync`        | Re-list + reconcile                                                                                                                                                                       |

## OAuth servers (the MCP auth flow)

For servers that authenticate via OAuth 2.1 (e.g. Firecrawl's
`/v2/mcp-oauth`), the connector runs the full MCP client flow — RFC 9728
discovery, RFC 8414 metadata, RFC 7591 dynamic registration, PKCE
authorization code, silent refresh — via the SDK's `auth()` orchestrator.
Engine: `packages/tools/src/mcp-oauth.ts`.

- **Where things live.** Non-secret bookkeeping (status, client_id, pending
  flow, expiry) sits on `integration.mcp.oauth`. The registration JSON,
  tokens, and PKCE verifier are **vault-sealed** under the connector's group
  slug (labels `oauth-client` / `oauth-tokens` / `oauth-verifier`) and never
  cross the API or reach a model — the keys screen hides them, the key-test
  probe refuses them, and the connectors API derives "connected" from actual
  token presence rather than trusting the stored status.
- **The flow.** `POST /api/mcp-connectors` with `"oauth": true` (or
  `POST /api/mcp-connectors/<slug>/oauth/start` later) returns an
  `authorizeUrl`. The OWNER opens it in a browser, approves, and the provider
  redirects to `GET /api/mcp-connectors/oauth/callback` (owner-gated), which
  exchanges the code, seals the tokens, and runs the first sync.
- **Runtime.** The transport refreshes tokens silently. When a refresh dies,
  the connector flips to `needs_reconnect`, tool calls return a teaching
  error naming the reconnect route, and `oauth/start` re-arms the flow.
- **Same egress rules.** Discovery/registration/token requests run through
  the SSRF guard with redirects refused, like every other connector request.

## The catalog

`KNOWN_MCP_SERVERS` (`packages/tools/src/mcp-catalog.ts`) is the
`KNOWN_KEY_SERVICES` twin: server-driven placeholder rows with `whenToUse`
prose that lands in the generated group description — that's where
"call this vs the built-ins" judgment lives. The Firecrawl entry marks the
boundary explicitly: `web_map`/`web_crawl` own crawl-and-ingest;
the connector is for ad-hoc scrape/search/extract into context.
The DeepWiki entry (no auth at all — an empty binding is valid) is the
generality proof: an unrelated third-party server, verified live.
Pre-known services are **not** auto-provisioned.

## Firecrawl quick start

Key-authed:

1. Store the key: Settings → API keys, service `firecrawl`, label `default`.
2. `POST /api/mcp-connectors` with
   `{ "slug": "firecrawl", "url": "https://mcp.firecrawl.dev/v2/mcp",
"secretRef": "firecrawl/default" }`.
3. Grant `mcp-firecrawl` to the researcher (or another no-write specialist).

OAuth (no stored key):

1. `POST /api/mcp-connectors` with `{ "slug": "firecrawl",
"url": "https://mcp.firecrawl.dev/v2/mcp-oauth", "oauth": true }`.
2. Open the returned `authorizeUrl` in the browser and approve; the callback
   page confirms the sync.
3. Grant `mcp-firecrawl` as above.

## Deferred

stdio transports (sandbox infra only, never the web process), MCP
resources/prompts. The `/settings/connectors` screen lives in the jackdaw
repo; its nav entry ships here in `@crossworks/share-ui` (nav-items) and
reaches the client on the next pin bump.
