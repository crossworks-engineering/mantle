# OpenAPI connectors: a service's spec as an http tool group

Point Mantle at a service's OpenAPI 3.x spec URL and its operations become a
normal per-connector **tool group** of ordinary `http` tools any agent can be
granted. The raw-API twin of [MCP connectors](./mcp-connectors.md), built on
the same pattern; the plan that shaped this:
[`docs/plans/openapi-connector.md`](./plans/openapi-connector.md). The
settings UI extension is the remaining (jackdaw) phase.

## The model: no new entities, no new handler kind

A connector **IS** a `tool_groups` row (slug `openapi-<connector>`), extended:

- `integration.openapi` carries the binding: `{ specUrl, specHash, selection,
  apiTitle, apiVersion, lastSyncAt, toolCount }`. It COMPOSES with the
  existing integration fields: the group's `baseUrl`, `secretRef` and
  `authTemplate` feed the same authoring-time inheritance hand-authored http
  tools use, so **auth is owner-set and never comes from the spec**.
  Validated by `parseOpenapiBinding` (`packages/tools/src/integration-meta.ts`).
- Each selected operation is an ordinary `tools` row with
  `handler.kind === 'http'` (slug `openapi_<connector>_<operation>`) plus a
  provenance block `handler.openapi = { group, op }`. It flows through the
  same resolve → allowlist → confirm → dispatch pipeline, templating engine,
  SSRF guard, secret scrubbing, and untrusted fencing as every other http
  tool. The dispatcher gained no new case.

## Sync: explicit, never scheduled

`syncOpenapiConnector` (`packages/tools/src/openapi-sync.ts`) fetches the
spec (SSRF-guarded, 5 MB cap, sha256-hashed), parses it
(`openapi-spec.ts`: JSON or YAML, OpenAPI 3.0/3.1, internal `$ref`s only
with depth/budget caps, Swagger 2.0 refused), compiles the selected
operations, and reconciles rows: insert new, update changed (identity is the
operation, `operationId` or `method /path`, so a slug-convention change
cannot fork rows), **disable** vanished or deselected (never delete;
`handler.openapi.vanishedAt` marks a sync-disable so an OWNER disable is
never overridden), re-enable returners, then rewrite the group's `toolSlugs`
to the live set. Runs on create and on demand
(`POST /api/openapi-connectors/<slug>/sync`). Never on a cron.

While the group has no `baseUrl`, the sync adopts the spec's first usable
root `servers` URL and says so; once set, a spec change never moves it.

## Selection and the tool cap

Real specs carry hundreds of operations and every tool description is paid
for in the system prompt on every turn. `integration.openapi.selection`
holds `tags` (include operations carrying those spec tags) and/or
`operations` (explicit identities); the effective set is the union, and no
selection means ALL. **Hard cap: 80 tools per connector**; a sync whose
selection exceeds it fails with a teaching error, and above 30 the result
warns. The pick step is `POST /api/openapi-connectors/preview { specUrl }`:
fetch + parse WITHOUT creating anything, returning the inventory (title,
servers, security schemes, tags with counts, operations with summaries).

## Hand-edits survive re-sync (the deliberate mcp difference)

An mcp row mirrors remote execution, so editing it is meaningless. An
openapi row's template IS the execution, and spec prose is often bad, so
Toolsmith improving a description or fixing a template is a feature:
`api_tool_update` works on these rows, and the crud layer stamps
`handler.openapi.editedAt`. The sync then **keeps edited rows untouched**
(reported as `keptEdited`) until a sync with `overwriteEdited: true`
restores the spec version and clears the stamp. Membership stays sync-owned
either way: hand-authored tools cannot join an `openapi-*` group, mirrored
rows cannot be bundled into other groups, re-homed, hand-created, or deleted
(disable them, change the selection, or delete the connector).

## Compilation rules

- URL: group `baseUrl` + the spec path; OpenAPI's `{param}` path templating
  is literally the http engine's own syntax.
- Query params become `handler.query` templates; a pair whose optional
  param is omitted is dropped from the request (an engine improvement that
  applies to all http tools, see `http-template.ts`).
- A JSON object request body spreads its fields at the top level of the
  input schema (the engine's spillover assembles the body); a field that
  collides with a param name nests the whole body under one `body` property
  with an explicit `{body}` template instead. Non-JSON bodies skip the
  operation with a warning.
- Header/cookie params are not compiled (auth belongs to `authTemplate`).
- Non-identifier param names get a sanitised input name; the wire name is
  preserved and noted in the param description.
- Input schemas carry the spec's types/enums/descriptions, are closed with
  `additionalProperties: false`, and cap at 30k chars (open-object fallback).
- Descriptions come from `summary` + `description`, capped at 2k chars.

## Guardrails

- **Spec text is third-party.** `{{secret:` openers are stripped from every
  spec-derived string, so a hostile spec cannot name the owner's vault refs
  into a template the dispatcher would resolve. Path- and operation-level
  `servers` overrides are IGNORED (warned): every tool calls the one
  owner-visible base URL.
- **Namespace reserved.** `tool_group_ensure` refuses `openapi-*` slugs and
  binding-carrying groups; the generic tool-groups PATCH refuses
  membership/binding edits; the generic DELETE delegates to the
  connector-aware delete (rows + group + grants). The prefix is `openapi-`,
  not `api-`, because `api-<group>` is the usage-skill naming convention.
- **Grants.** Connector groups are granted to no one by default; the
  generated description recommends a no-write specialist. Granting one
  teaches the parent via the delegate roster like any group.
- **No auto usage skill.** A skill body enters system prompts at
  brain-authored trust; spec prose stays out. Toolsmith may author
  `api-openapi-<slug>` via `api_skill_set` and it travels with the grant
  through the existing `integration.skillSlug` mechanism.

## API (owner-gated)

| Route                                             | Does                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/openapi-connectors`                     | Connected specs + the `KNOWN_OPENAPI_APIS` catalog (placeholder rows, `connected` flags)                    |
| `POST /api/openapi-connectors`                    | `{ slug, specUrl, baseUrl?, secretRef?, authTemplate?, selection?, name? }` → creates `openapi-<slug>` + first sync (a failed first sync keeps the group; fix config, resync) |
| `POST /api/openapi-connectors/preview`            | `{ specUrl }` → the spec inventory, nothing created                                                          |
| `GET/PATCH/DELETE /api/openapi-connectors/<slug>` | Inspect / edit binding, base URL, auth, selection / delete (rows + group + grants)                           |
| `POST /api/openapi-connectors/<slug>/sync`        | Re-fetch + reconcile; `{ overwriteEdited: true }` reclaims hand-edited rows                                  |

## Quick start (Open-Meteo, no key)

1. `POST /api/openapi-connectors` with
   `{ "slug": "open-meteo", "specUrl":
   "https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml" }`
   (the catalog supplies `baseUrl` `https://api.open-meteo.com`).
2. Grant `openapi-open-meteo` to the researcher (or another no-write
   specialist).
3. Ask in chat for the forecast at a latitude/longitude.

For a key-authed API, store the key under Settings → API keys first and pass
`secretRef` + `authTemplate` (e.g.
`{ "query": { "appid": "{{secret:svc/default}}" } }`) at create, exactly as
for a hand-built integration group.

## Deferred

Swagger 2.0 conversion, external `$ref` following, header/cookie params,
auto-generated usage skills, webhooks/callbacks, any scheduled re-sync. The
`/settings/connectors` screen extension lives in the jackdaw repo.
