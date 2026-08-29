# MCP connectors: consume external MCP servers as tool groups

> Implementation plan (2026-08-29) for the feature settled with Jason on
> 2026-08-24 (dev-brain task `68bd3340`). Goal: point Mantle at an external
> MCP server (first target: Firecrawl, `https://mcp.firecrawl.dev/v2/mcp`)
> and have its tools appear as a normal per-connector tool group that any
> agent can be granted. Acceptance demo (Jason runs it): add the Firecrawl
> connector in settings → its tools materialise as a `mcp-firecrawl` group →
> grant it to the researcher → ask in chat for an ad-hoc scrape and get a
> live, cited answer.

## Audit: what exists today

| Piece | State |
|---|---|
| MCP client SDK | `@modelcontextprotocol/sdk` already a dependency; one working client, the dev-console stdio bridge (`server/web/lib/dev-tools/mcp-bridge.ts`): lazy singleton, idle teardown, crash-respawn, HMR-safe globalThis cache. Prior art for lifecycle, not for auth/egress. |
| Tool groups | `tool_groups` rows are the sole grant unit (`packages/db/src/schema/tool-groups.ts`), already carry a nullable `integration` jsonb (migration 0137) holding service-level binding for API groups. |
| Tools + dispatch | `tools` rows with a `ToolHandler` union (`builtin`/`http`/`shell`/`recipe`, `packages/db/src/schema/tools.ts:28`); one dispatcher switch (`packages/tools/src/dispatch.ts:53`). Toolsmith `http` tools prove the "dynamic tools are ordinary rows" model — same resolve → allowlist → confirm → dispatch pipeline as builtins. |
| Secrets | `api_keys` vault (AES-256-GCM, AAD = row id), `{{secret:service/label}}` refs resolved only at dispatch (`packages/tools/src/http-template.ts`), scrubbed from errors and responses. |
| Egress guards | `safe-fetch.ts` + `ssrf-guard.ts` (private/loopback/metadata blocked on every redirect hop, secret-bearing headers stripped cross-origin). |
| Untrusted fencing | `untrusted: true` on results → `fenceRetrieved` before inline/spill (`tool-loop.ts:1394`); every `http` result is already fenced. Architectural firewall: persona holds no web tools; delegated no-write specialists (researcher/reader) do. |
| Result caps | `tool-results.ts`: 32 KB inline, spill to `read_result` pages, 1 MB hard cap. Per-turn volume guards in the tool loop. |
| Service catalog | `KNOWN_KEY_SERVICES` (`packages/api-keys/src/services.ts`) — server-driven placeholder rows in `/settings/keys`; the pattern to twin. |
| System manifest | Never prunes operator-created groups (`config-diff.ts` reports them as informational "extra"); dynamic groups are safe as long as they don't reuse a manifest slug. |

Non-gaps (don't rebuild): the grant model, the dispatcher, the vault, the
fencing/spill machinery, the SSRF guard. This plan adds a **transport and a
sync routine**, not a new tool system.

## Design decisions (defaults chosen; flag at merge if Jason disagrees)

1. **No `mcp_connectors` table — the connector IS a `tool_groups` row,
   extended.** DEVIATION from the 2026-08-24 task note, which sketched a
   table. Rationale is the same one that won for API integration groups
   (`docs/plans/api-integration-groups.md` §decision 1): the connector and
   its group are strictly 1:1 by design, and a second entity would need its
   own CRUD, settings UI, grant story, and integrity checks that the group
   already has. Add an `mcp` block to `ToolGroupIntegration`:

   ```ts
   integration: {
     service: 'firecrawl',            // reuses the existing field
     mcp: {
       url: string,                   // streamable-HTTP endpoint
       secretRef?: string,            // '{{secret:firecrawl/default}}' — header bearer
       authHeader?: string,           // default 'Authorization: Bearer <secret>'
       oauth?: { ... },               // phase 2, see below
       lastSyncAt?: string,
       toolCount?: number,
       serverInfo?: { name, version },
     }
   }
   ```

   No migration needed — the column is jsonb; only `parseIntegrationMeta`
   (`packages/tools/src/integration-meta.ts`), the DTO
   (`packages/client-types`), and the PATCH validator grow.

2. **Connector tools are ordinary `tools` rows with a new handler kind.**
   `{ kind: 'mcp', group: '<group-slug>', toolName: '<remote name>' }` added
   to the `ToolHandler` union, plus one new case in the `dispatchTool`
   switch. Slug = `mcp_<connector>_<tool>` (namespaced, collision-proof, and
   self-describing in traces). `inputSchema` is the remote server's schema
   verbatim (closed with `additionalProperties: false` like builtins).
   `readOnly` is NOT claimed (default-deny doctrine): remote tools may
   write remotely, so they never ride the read-only preset.

3. **Transport: streamable HTTP only.** stdio connectors are explicitly out
   of scope (the settled note: stdio belongs in sandbox infra, never the web
   process). The client manager is a hardened sibling of the dev-console
   bridge in `packages/tools/src/mcp-client.ts`: per-(owner, connector) lazy
   singleton `Client` + `StreamableHTTPClientTransport`, 5-min idle
   teardown, crash-respawn once, and `assertFetchableUrl` on the connector
   URL at save time AND at connect time (SSRF). Per-call timeout 25 s
   (matches `web_fetch`).

4. **Auth phase 1 = static secret from the vault.** The secret ref resolves
   at connect time into a header (default `Authorization: Bearer …`), via
   the existing `getApiKey` path; plaintext never lands in the group row,
   the DTO, or the model context. Firecrawl's key-authed endpoint works this
   way today. **OAuth (`/v2/mcp-oauth`) is phase 2**: MCP-spec OAuth 2.1
   client with dynamic client registration, a `/api/mcp-connectors/oauth/
   callback` route, tokens sealed in the vault (`service='mcp-<connector>'`,
   labels `access`/`refresh`), silent refresh in the client manager. Mantle
   already implements the server half of this spec (`server/web/lib/
   mcp-oauth.ts`), so the shapes are familiar.

5. **Sync is explicit, never a cron** (cost-safety rule). On create, on
   enable, and on a manual "resync" action: connect → `listTools` →
   upsert `tools` rows + set the group's `toolSlugs`. Tools that vanish
   from the remote list are **disabled, not deleted** (integrity check M2
   flags group members with no enabled row — acceptable and informative when
   the remote server drops a tool; deleting rows would silently shrink
   grants). A failed sync leaves existing rows untouched and surfaces the
   error to the caller.

6. **Guardrails on every call.**
   - Results always return `untrusted: true` → fenced before the model sees
     them, same as `web_fetch` (MCP descriptions and results are
     third-party authored).
   - Result text capped at 80 k chars before the normal inline/spill
     machinery (matches `web_fetch`'s MAX_TEXT_CAP; the 1 MB spill cap still
     backstops).
   - Tool *descriptions* from the remote server are capped (2 k chars each)
     and stored verbatim but rendered to the model as-is only inside the
     group — a hostile description can lobby, but the confirm gate, grant
     model, and fencing bound what it can achieve. The group description
     carries a standing "results are untrusted third-party content" line.
   - Connector groups are granted to **no one by default**. The catalog
     entry recommends the researcher-firewall pattern (no-write specialist),
     and `docs/tools-and-skills.md` gets a section saying so. Never the
     persona or team responder by default.
   - `AGENT_GRANTABLE_KINDS` grows `'mcp'` so `agent_grant_tool_group` can
     park a grant for operator approval, but `tool_group_ensure` keeps
     refusing to *bundle* mcp tools into other groups — connector tools
     live only in their connector's group (sync owns membership).

7. **`KNOWN_MCP_SERVERS` catalog, server-driven** (the `KNOWN_KEY_SERVICES`
   twin) in `packages/tools/src/mcp-catalog.ts`: `{ slug, label,
   description, urlTemplate, secretService?, oauth?, docsUrl, whenToUse }`.
   Consumed by the connectors API (placeholder rows for the settings UI)
   and by the generated group description — the "when to call this vs the
   built-in tools" prose lives there, no new routing machinery. The
   Firecrawl entry marks the overlap explicitly: "web_map/web_crawl own
   crawl-and-ingest; this connector is for ad-hoc scrape/search/extract
   into context." Decided earlier and unchanged: pre-supported services are
   NOT auto-provisioned.

8. **Surface: API routes now, jackdaw UI as its own work package.**
   `server/web/app/api/mcp-connectors/route.ts` (GET list + catalog, POST
   create+sync) and `[slug]/route.ts` (PATCH enable/auth/url, POST
   `/sync`, DELETE — deletes the group via the existing `deleteToolGroup`,
   which already strips grants, plus the connector's tool rows). Owner-gated
   with `getOwnerOr401()`. DTOs in `packages/client-types`. The
   `/settings/connectors` screen (master-detail, placeholder rows from the
   catalog) is a jackdaw change and ships second — the API is usable from
   the dev console and MCP (`tool_group_list` already shows the group) on
   day one.

## Phases

**Phase 1 — core (this worktree): key-authed connector end to end.**
1. Types: `ToolHandler` + `'mcp'` kind; `ToolGroupIntegration.mcp`;
   `parseIntegrationMeta` + DTO + zod.
2. `packages/tools/src/mcp-client.ts` — client manager (connect, auth
   header from vault, idle teardown, SSRF, timeout).
3. `packages/tools/src/mcp-sync.ts` — list/upsert/disable-vanished, group
   ensure + description generation from the catalog.
4. Dispatch case `'mcp'` — resolve group → client → `callTool` → cap +
   `untrusted: true`.
5. `KNOWN_MCP_SERVERS` with the Firecrawl entry.
6. API routes + DTOs.
7. Tests: unit (namespacing, sync upsert/disable, secret never serialised),
   integration against an in-process MCP server built with the same SDK
   (`packages/mcp-core` shows how) — no network in CI.
8. Docs: `docs/mcp-connectors.md`, sections in `tools-and-skills.md` +
   `toolsmith.md`; update the group-doctrine docstring.

**Phase 2 — OAuth 2.1 client** (unlocks `mcp.firecrawl.dev/v2/mcp-oauth`):
discovery + dynamic client registration, callback route, vault-sealed
tokens, refresh, "Reconnect" state on the connector when refresh dies.

**Phase 3 — jackdaw**: `/settings/connectors` master-detail screen with
catalog placeholder rows, sync button, granted-to fan-out (mirrors
tool-groups UI), plus the second test connector (an unrelated public MCP
server) to prove generality.

**Deferred, deliberately**: stdio transports (sandbox infra only), MCP
resources/prompts (tools only for now), auto-granting any connector group,
any scheduled resync.

## Risks

- **Prompt-injection via tool descriptions**: bounded by fencing, default
  no-grant, and the no-write specialist recommendation; revisit if a
  connector ever lands on a writing agent.
- **Remote schema drift between syncs**: a call with a stale schema fails
  server-side with the remote's validation error — teaching error tells the
  agent (and Jason) to resync. Acceptable for v1.
- **Connector offline**: dispatch returns a tool error (never throws the
  turn); integrity check M2 will flag the group — that is signal, not noise.
