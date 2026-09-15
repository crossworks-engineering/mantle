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

| Route                                         | Does                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mcp-connectors`                     | Connected servers + the `KNOWN_MCP_SERVERS` catalog (placeholder rows, `connected` flags)                                                                                                                                                                                                            |
| `POST /api/mcp-connectors`                    | `{ slug, url, secretRef?, authHeader?, authScheme?, name?, oauth?, oauthClient?, scope? }` → creates `mcp-<slug>` + first sync (OAuth: returns `authorizeUrl`, or `oauthError` if the flow could not start). A failed first sync keeps the group (`syncError` in the response) — fix config, resync. |
| `GET/PATCH/DELETE /api/mcp-connectors/<slug>` | Inspect / edit binding, OAuth app (`oauthClient`) and `scope` (bounces the cached client) / delete (rows + group + grants)                                                                                                                                                                           |
| `POST /api/mcp-connectors/<slug>/sync`        | Re-list + reconcile                                                                                                                                                                                                                                                                                  |

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

## Servers without dynamic registration (pre-registered apps)

Some authorization servers do not let a client register itself. Microsoft
Entra ID is the big one: it fronts every Microsoft MCP server, Power BI
included. There the connector uses an app someone registered by hand, set as
`integration.mcp.oauth.client`:

| `client`                                     | Where the app comes from                                                                                      | Sign-in goes to                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| absent                                       | RFC 7591 dynamic registration (the default)                                                                   | wherever RFC 9728 discovery points                                                 |
| `{ source: 'microsoft' }`                    | the Settings → Microsoft app (client id, secret, tenant), resolved on every flow, never copied                | that app's **tenant** authority, `https://login.microsoftonline.com/<tenant>/v2.0` |
| `{ source: 'manual', authorizationServer? }` | an app registered by hand: its id on `oauth.clientId`, its secret sealed in `oauth-client` like a dynamic one | `authorizationServer` if set, else discovery                                       |

Set it at create (`"oauthClient": { "source": "microsoft" }` on
`POST /api/mcp-connectors`) or later (`oauthClient` on
`PATCH /api/mcp-connectors/<slug>`). A real change drops the old app's tokens,
and the owner authorizes again; re-sending the current app is a no-op, so a
form save cannot cut a live connection. `scope` (create and patch, `''`
clears) overrides the scope asked for.

What the Microsoft app changes, and why (engine:
`packages/tools/src/mcp-oauth.ts`, all through the SDK's own provider hooks):

- **Tenant authority, not `organizations`.** Power BI's metadata names the
  generic multi-tenant endpoint. A single-tenant app cannot sign in there
  (AADSTS50194), so `discoveryState()` points the SDK at the tenant.
- **`offline_access` is always added** to the scope (the server's
  `scopes_supported`, unless `scope` is set). Without it Entra issues no
  refresh token, and the connection dies at the first access-token expiry.
- **`prompt=select_account`, not the SDK's `prompt=consent`.** The SDK adds
  `consent` whenever `offline_access` is asked for. On a tenant where users
  may not consent to apps themselves, that blocks an app an admin has
  already consented.
- **No RFC 8707 `resource` parameter** (`validateResourceURL()` returns
  nothing): Entra v2 takes the audience from the scope.
- **The secret goes in the body** (`client_secret_post`), like the Graph
  sign-in in `packages/microsoft/src/oauth.ts`.

Failures are recorded, never silent. A failed start, a refused consent on the
callback, or a failed code exchange clears the in-flight marker and stores the
reason as `oauth.lastError`, with the cure appended for the Entra errors an
owner can hit (AADSTS700025, 7000215, 7000222, 65001, 50011, 50194). The code
exchange keeps the FIRST token-endpoint error: on `invalid_client` the SDK
retries by itself, and the retry's error would otherwise bury the real one.
`GET /api/mcp-connectors` also returns `oauthRedirectUri` (the exact URL to
register with the app) and `microsoftApp` (whether one is configured, and
which client id and tenant).

### Power BI (catalogue entry `powerbi`)

Microsoft's remote Power BI MCP server,
`https://api.fabric.microsoft.com/v1/mcp/powerbi`, uses the Microsoft app.
Before connecting, on the customer's side:

1. A Power BI admin enables the tenant setting "Users can use the Power BI
   Model Context Protocol server endpoint (preview)".
2. On the Settings → Microsoft app in Azure: API permissions → Power BI
   Service → delegated `Dataset.Read.All`, `MLModel.Execute.All` and
   `Workspace.Read.All`, then Grant admin consent.
3. On the same app: add `oauthRedirectUri` as a **Web** redirect URI.
   Microsoft's
   [guide for external clients](https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-external-clients)
   says "Mobile and desktop", but it is written for desktop apps that hold no
   secret. Mantle is a confidential server app, and Entra refuses a secret on
   a public-client redirect (AADSTS700025).
4. Each user needs Build permission on the semantic models they query.

Its Generate Query tool spends Copilot capacity. The catalogue's `whenToUse`
steers agents to read the model's schema and write the DAX themselves.

## The catalog

`KNOWN_MCP_SERVERS` (`packages/tools/src/mcp-catalog.ts`) is the
`KNOWN_KEY_SERVICES` twin: server-driven placeholder rows with `whenToUse`
prose that lands in the generated group description — that's where
"call this vs the built-ins" judgment lives. The Firecrawl entry marks the
boundary explicitly: `web_map`/`web_crawl` own crawl-and-ingest;
the connector is for ad-hoc scrape/search/extract into context. Entries for servers behind Entra
carry `oauthClient: 'microsoft'` plus `setup`, the customer-side steps, which
the settings UI shows before anyone connects.
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
