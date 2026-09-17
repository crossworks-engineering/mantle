# OpenAPI connectors: materialise a spec as an http tool group

> Handover plan (2026-08-29) for an implementing session in a worktree
> (`scripts/new-worktree.sh openapi-connector`). Feature settled with Jason
> 2026-08-29: point Mantle at a service's OpenAPI/Swagger spec URL and its
> operations materialise as ordinary `http` tools inside a per-connector tool
> group, giving raw APIs the same one-click feel as MCP connectors. This is
> the deliberate sibling of the just-shipped MCP connector work (dev-brain
> task `68bd3340`, `docs/plans/mcp-connectors.md`, `docs/mcp-connectors.md`):
> reuse that pattern everywhere it fits, deviate only where the spec-shaped
> source demands it. Acceptance demo (Jason runs it): add a connector for a
> public no-key API (candidate: Open-Meteo) → pick two operations → grant the
> group to the researcher → ask for a forecast in chat and get a live answer.

## Audit: what exists to reuse (it is most of the machine)

| Piece | State |
|---|---|
| The connector pattern | Fully shipped for MCP (v0.232.70-73): connector = extended `tool_groups` row, explicit sync, disable-on-vanish with a handler marker, membership = enabled remote-present rows, reserved namespace, ownership guards on every generic surface, catalog, settings screen, help page, security.md row. `packages/tools/src/mcp-{catalog,client,sync,oauth}.ts` |
| `http` handler + dispatch | `ToolHandler` `http` kind (`packages/db/src/schema/tools.ts:31`): url/method/headers/query/body templates, `{param}` from input, `{{secret:service/label}}` from the vault at dispatch. Engine: `packages/tools/src/http-template.ts` (spillover rules, secret tokenisation, `scrubSecrets`). Egress: `safe-fetch.ts` (per-hop SSRF guard, cross-origin secret stripping). Results are fenced as untrusted by the tool loop. **The dispatcher needs no new handler kind.** |
| Integration binding | `tool_groups.integration` jsonb already carries `service`, `baseUrl`, `secretRef`, `authTemplate`, `docsNodeId`, `skillSlug`, and the `mcp` block. Validation: `parseIntegrationMeta` / `parseMcpBinding` (`packages/tools/src/integration-meta.ts`). |
| Authoring-time inheritance | `applyIntegrationInheritance` + `joinBaseUrl` (`integration-meta.ts:482`): folds group `baseUrl` + `authTemplate` into a tool's stored templates at authoring time; the tool wins on conflict. Exactly what a spec-driven author needs. |
| Sync shape | `mcp-sync.ts` is the template: pure `planMcpSync` (insert/update/disable from plain data) + impure apply; identity by remote name, `handler.vanishedAt` marker so owner-disables are never overridden; group `toolSlugs` rewritten to the live enabled set; never a cron. |
| Guards to mirror | `tool_group_ensure` refuses the `mcp-` namespace and binding-carrying groups (`builtins-toolsmith.ts:1604`); generic `PATCH/DELETE /api/tool-groups/[id]` delegates/refuses; tool crud refuses create/re-kind/delete of connector rows; recipe envelope refuses mcp steps. |
| Group → skill travel | `resolveAgentSkills` (`packages/runtime/src/agent/skills.ts`) already unions granted groups' `integration.skillSlug` into an agent's effective skills. `apiSkillSlugForGroup(groupSlug)` = `api-<groupSlug>` is the naming convention. |
| Catalog pattern | `KNOWN_MCP_SERVERS` (`mcp-catalog.ts`), server-driven placeholder rows; `whenToUse` prose lands in the generated group description. |
| Test pattern | `mcp-client.test.ts`: an in-process HTTP server on 127.0.0.1, SSRF guard stubbed, vault mocked; plus pure plan tests in `mcp-sync.test.ts`. |
| Surfaces | `/settings/connectors` (jackdaw, master-detail, catalog prefill), `docs/guide/06-help/connectors.md` + `help-topics.ts` (two-edit convention), `docs/security.md` surface table, delegate roster (group-level, live). |

Non-gaps (do not rebuild): the dispatcher, templating, vault, fencing, SSRF
guard, grant model, sync philosophy, the settings screen skeleton. This plan
adds a **spec parser and a second sync source**, not a second tool system.

## Design decisions (defaults chosen; flag at merge if Jason disagrees)

1. **No new handler kind: synced tools are ordinary `http` rows.** The spec
   is compiled, per operation, into the same url/headers/query/body templates
   Toolsmith writes by hand, so dispatch, fencing, secret scrubbing, traces,
   recipes, and the API console all work unchanged. Provenance rides an
   optional field on the http handler blob (jsonb, no migration):
   `handler.openapi = { group, op, vanishedAt?, editedAt? }` where `op` is
   the operation identity (see 6). Only the sync may write this field.

2. **Binding: `integration.openapi`, composing with the existing fields.**

   ```ts
   integration: {
     service: 'open-meteo',
     baseUrl?: string,        // existing field; inheritance uses it
     secretRef?: string,      // existing field
     authTemplate?: {...},    // existing field; owner-set auth placement
     openapi: {
       specUrl: string,
       specHash?: string,     // sha256 of the raw fetched bytes
       apiTitle?: string, apiVersion?: string,
       selection?: { tags?: string[], operations?: string[] },
       lastSyncAt?: string, toolCount?: number,
     }
   }
   ```

   `parseOpenapiBinding` joins `parseMcpBinding` in `integration-meta.ts`
   (camel+snake, round-trip of bookkeeping, teaching errors). The
   authoring-time inheritance the group already defines is what the sync
   feeds: relative spec paths join `baseUrl`, `authTemplate` merges into
   every generated tool. Auth is therefore **owner-set at create time**
   (same params `tool_group_ensure` takes), never derived from the spec;
   the sync result reports the spec's `securitySchemes` and warns when the
   spec declares security but the group carries no `authTemplate`.

3. **Group namespace: `openapi-<slug>`, NOT `api-<slug>`.** `api-<group>` is
   already the naming convention for integration usage skills
   (`apiSkillSlugForGroup`), so an `api-` group prefix would make skill and
   group names read as each other (`api-petstore` the skill of a plain
   `petstore` group vs `api-petstore` the connector group). `openapi-` is
   unambiguous, greppable, collides with no manifest slug, and its usage
   skill derives cleanly (`api-openapi-<slug>`). Reserve it exactly like
   `mcp-`: `tool_group_ensure` refuses the namespace and any group carrying
   `integration.openapi`; generic PATCH refuses membership/binding edits;
   generic DELETE delegates to the connector-aware delete. Tool slugs:
   `openapi_<connector>_<operation>` via a shared collision-suffixing helper
   (extract `mcpToolSlug`'s logic).

4. **Hard problem 1, operation blowup: explicit selection + a hard cap,
   never silent truncation.** Real specs carry 100-300 operations and every
   tool description is paid for in the system prompt on every turn.
   - `integration.openapi.selection` holds `tags` (include every operation
     carrying one of these spec tags) and/or `operations` (explicit
     operation identities); the effective set is the union. No selection
     means "all", which is only legal under the cap.
   - **Hard cap: 80 enabled tools per connector.** A sync whose effective
     set exceeds it FAILS with a teaching error naming the count and the
     selection mechanism; nothing is dropped silently (house rule). The
     sync result warns above 30 that the group is context-heavy.
   - The pick step is served by `POST /api/openapi-connectors/preview`
     `{ specUrl }`: fetch + parse WITHOUT creating anything, return the
     inventory (title, version, servers, securitySchemes, tags with counts,
     operations with id/method/path/summary). The settings UI and Toolsmith
     both drive selection from it.
   - Per-tool descriptions from the spec (`summary` + `description`) are
     capped at 2,000 chars (the MCP cap); input schemas at 30k chars with
     the same open-object fallback.

5. **Hard problem 3, coexistence with hand-edits: sync owns membership,
   edits to synced rows survive.** The MCP model (crud refuses all edits)
   is wrong here: an mcp row is a mirror of remote execution, but an
   openapi row's template IS the execution, and spec prose is often bad, so
   Toolsmith improving a description or fixing a body template is a
   feature. Rules:
   - Membership is sync-owned, exactly like MCP: `toolSlugs` is rewritten
     to the enabled spec-present selected set each sync; hand-authored
     tools cannot be added to an `openapi-*` group (author them into a
     plain integration group instead).
   - `api_tool_update` MAY patch a synced row (description, schema,
     templates; never the kind, never `handler.openapi`); doing so stamps
     `handler.openapi.editedAt`. Re-sync **skips edited rows** (reports
     "N kept as hand-edited") unless the call passes `overwrite_edited`,
     which restores the spec version and clears the stamp.
   - `api_tool_create` refuses a handler carrying `openapi` provenance;
     `api_tool_delete` refuses synced rows (disable it, change the
     selection, or delete the connector). Deselecting an operation behaves
     as a vanish: disabled with `vanishedAt`, re-enabled if re-selected.
   - Bundling a synced row into another group is refused (mirror MCP): the
     sync owns its lifecycle and deletion must stay clean. Recipes MAY wrap
     openapi tools; they are ordinary fenced http calls to a service the
     owner explicitly connected, the same trust class as any Toolsmith http
     tool (deviation from the MCP recipe refusal, reasoned above).

6. **Spec handling: OpenAPI 3.x, JSON + YAML, internal `$ref` only.**
   - Fetch through `safeFetch` with `assertFetchableUrl` (SSRF) and a
     **5 MB byte cap** (Stripe-class specs are ~6 MB; those must narrow via
     a mirror or a trimmed spec, and the error says so).
   - JSON parsed first, YAML fallback via the `yaml` package (new, small,
     zero-dep addition to `packages/tools`; JSON-only would bounce half the
     public spec corpus). Swagger 2.0 is refused with a teaching error
     naming a converter (no conversion shipped in v1).
   - `$ref`: internal (`#/components/...`) only, resolution depth cap 8 and
     a resolved-node budget; cycles and external/remote refs degrade to an
     open object with a sync warning. Remote refs are an SSRF/complexity
     hole we do not open.
   - Operation identity (`handler.openapi.op`): `operationId` when present,
     else `<method> <path>` normalised. Identity, not slug, keys the sync
     (a slug-sanitisation change must not fork rows), mirroring MCP.

7. **Template mapping (the compiler, pure).** Per operation:
   - URL: group `baseUrl` + the spec path. OpenAPI path templating is
     literally `{param}`, the exact syntax `http-template.ts` fills and
     URL-encodes; zero translation.
   - Query params: `handler.query = { name: '{name}' }` per declared param.
   - Body (POST/PUT/PATCH with a JSON request body): body schema properties
     are spread at the TOP level of the input schema, no explicit body
     template; the engine's spillover rule (unconsumed input becomes the
     JSON body) assembles it. Name collisions across locations are
     uniquified with a location prefix (path wins the bare name, then
     query, then body), noted in the param description.
   - Header/cookie params are SKIPPED in v1 (rarely load-bearing outside
     auth, which `authTemplate` owns) with a sync warning naming them.
   - Input schema: params + body fields with the spec's own types/enums/
     descriptions, `required` derived from the spec, closed with
     `additionalProperties: false`.
   - **One shared-engine tweak, the single deviation Jason should eyeball:**
     `buildHttpRequest` currently sends a query pair whose `{param}` went
     unfilled as the literal brace string, which breaks OPTIONAL query
     params for every http tool. Add: after substitution, drop query pairs
     whose value still contains an unfilled placeholder. Additive, pure,
     unit-tested; it fixes optional params for hand-authored tools too.
     Risk is an author who wanted literal `{word}` braces in a query value,
     which nothing in the corpus does.
   - Response media types are ignored: the http dispatch path already caps,
     scrubs, and fences whatever comes back.

8. **Spec text is third-party: strip credential refs, pin the host.** A
   malicious spec could embed `{{secret:openweathermap/default}}` in a path
   or param default and the dispatcher would resolve the owner's OTHER
   credential into a request to the spec's own host. The compiler strips
   `{{secret:` sequences from every spec-derived string; only the group's
   owner-set `authTemplate` contributes refs. Operation- and path-level
   `servers` overrides are IGNORED (sync warning): every generated tool
   calls the group's single owner-visible `baseUrl`. `baseUrl` defaults
   from the spec's root `servers[0]` at CREATE only (absolute http(s) only,
   surfaced in the result), and the owner can override it thereafter.

9. **Hard problem 4, usage skill: NOT auto-generated.** A skill body enters
   system prompts unfenced at brain-authored trust; auto-distilling spec
   prose into one would smuggle third-party text past exactly the boundary
   the delegate-roster decision drew (brain-authored text only). MCP
   connectors ship no usage skill either; the generated group description
   (untrusted-content note + catalog `whenToUse`) is the prose rung.
   Toolsmith MAY author `api-openapi-<slug>` afterwards through the
   existing `api_skill_set` path, and `integration.skillSlug` already makes
   it travel with the grant, zero new code. Same reasoning for docs: the
   sync does NOT auto-store the spec as the group's docs file by default
   (eager ingest summarisation of a machine-format blob is LLM spend on
   every spec change); create/sync accept `store_spec: true` to write it
   through the `api_docs_set` pipeline (provenance header, 400k cap,
   rewritten only when `specHash` changes).

10. **Hard problem 5, defaults and surfaces.**
    - **System manifest: nothing ships.** Connectors are operator-created
      runtime objects, exactly like MCP. `config-diff.ts` learns to label
      `openapi-*` extras as connector groups (the `mcp-*` twin) and
      `group-checks.ts` findings name the re-sync recovery. No manifest
      entry, no onboarding step.
    - **Catalog: `KNOWN_OPENAPI_APIS`** (`openapi-catalog.ts`), the same
      server-driven twin: `{ slug, label, description, specUrl,
      secretService?, docsUrl, whenToUse }`. Ship only entries verified
      LIVE during implementation; candidates: Open-Meteo (no key, the
      acceptance demo) and GitHub REST (the selection-mechanism showcase,
      hundreds of operations). Never auto-provisioned.
    - **Settings UI: extend `/settings/connectors` in jackdaw**, not a
      second screen. One mental model ("connect an external service"),
      one master-detail already built; the list gains a type badge
      (MCP / OpenAPI) and the create flow a type choice, with the preview
      endpoint driving an operation picker. The API stays a separate
      namespace (`/api/openapi-connectors`) mirroring `/api/mcp-connectors`
      rather than overloading its zod/DTO shapes.
    - **Help: extend `docs/guide/06-help/connectors.md`** with the OpenAPI
      half. The route already maps to this page in `help-topics.ts`, so
      the two-edit convention costs one edit this time.
    - **security.md**: outbound bullet + surface-table row mirroring the
      MCP row (owner connects a spec explicitly; agents granted the
      `openapi-*` group call the service; results fenced; traces).
    - **Delegate roster: nothing extra.** It renders granted groups' brain-
      authored name + description at group level; `openapi-*` groups
      surface automatically on the parent's next turn. Verified against
      `docs/plans/delegate-roster.md` decisions 1-3 (the stoplist is a
      fixed list of core groups and does not touch connector slugs).

## Phases

**Phase 1 (this worktree): core, end to end via API.**
1. Types: `ToolGroupIntegration.openapi` + the http handler's optional
   `openapi` provenance field (`packages/db/src/schema/tool-groups.ts`,
   `tools.ts`; jsonb, no migration). DTO in `packages/client-types`.
2. `packages/tools/src/integration-meta.ts`: `parseOpenapiBinding`,
   `OPENAPI_GROUP_PREFIX`, shared slug helper extracted from `mcpToolSlug`.
3. `packages/tools/src/openapi-spec.ts` (new, pure): parse/validate 3.x
   (JSON+YAML), internal `$ref` resolution with caps, inventory extraction,
   per-operation input schema + http handler compilation (uses
   `applyIntegrationInheritance`/`joinBaseUrl`), secret-ref stripping.
4. `packages/tools/src/openapi-sync.ts` (new): `planOpenapiSync` (pure) +
   `syncOpenapiConnector` / `createOpenapiConnector` /
   `deleteOpenapiConnector`, mirroring `mcp-sync.ts` structure verbatim
   (vanish marker, owner-disable asymmetry, membership rewrite, failed
   first sync keeps the group). Spec fetch via `safeFetch` + 5 MB cap.
   Group description generator with the standing untrusted note.
5. `http-template.ts`: the unresolved-query-pair drop (+ tests).
6. Guards: `builtins-toolsmith.ts` (`tool_group_ensure` namespace/binding
   refusal, crud create/delete/re-kind refusals, `editedAt` stamping in
   `api_tool_update`, bundling refusal), `server/web/app/api/tool-groups/
   [id]/route.ts` (PATCH refusal + DELETE delegation),
   `config-diff.ts` + `group-checks.ts` labels.
7. Routes: `server/web/app/api/openapi-connectors/{route.ts, preview/
   route.ts, [slug]/route.ts, [slug]/sync/route.ts}` + `server/web/lib/
   openapi-connectors.ts` (list helper), all `getOwnerOr401()`.
8. `packages/tools/src/openapi-catalog.ts` with live-verified entries.
9. Dependency: `yaml` in `packages/tools/package.json`.
10. Docs: `docs/openapi-connectors.md` (the `mcp-connectors.md` sibling),
    sections in `tools-and-skills.md` + `toolsmith.md`, the help page
    extension, `security.md` row, this plan linked from the doc header.

**Phase 2 (jackdaw, own work package): the settings screen extension**
(type badge, create-with-type, operation picker off the preview endpoint,
selection editing, sync-now with the edited-rows report), then the pin bump
per the post-split release-pair process.

**Deferred, deliberately:** Swagger 2.0 conversion, external `$ref`
following, header/cookie params, auto-generated usage skills, response-shape
typing, webhooks/callbacks, any scheduled re-sync (cost-safety rule: sync
runs on create, on demand, never on a cron).

## Test strategy

- **Pure, no DB** (the `mcp-sync.test.ts` twin): spec parse happy paths in
  JSON and YAML for 3.0 and 3.1; Swagger 2.0 refusal; `$ref` depth/cycle
  degradation; inventory extraction; template compilation (path/query/body
  mapping, collision uniquification, required derivation, secret-ref
  stripping, servers-override ignore); slug/identity; `planOpenapiSync`
  (insert/update/disable/vanish/re-enable, owner-disable asymmetry,
  edited-row skip + overwrite, selection add/remove, over-cap failure);
  the `buildHttpRequest` query-drop tweak.
- **End to end, in process** (the `mcp-client.test.ts` twin): a
  `node:http` server on 127.0.0.1 serving a small spec AND implementing two
  operations (one GET with optional query, one POST with path param +
  body); SSRF guard stubbed, vault mocked; create → sync → dispatch the
  generated tool through the real `dispatchTool` and assert the assembled
  request (path fill, query, JSON body, inherited auth header) and the
  scrubbed, capped result. No external network in CI.
- `description-lint.test.ts` untouched (synced descriptions are dynamic
  rows, not builtins); typecheck `tools`, `db`, `client-types`, `web`;
  `pnpm verify` before the merge.

## Risks

- **Prompt-cost creep**: even a legal 80-tool connector is heavy; the cap,
  the >30 warning, and the docs' "select what you will use" guidance bound
  it, and selection can shrink a group at any time without losing grants.
- **Spec quality**: missing operationIds, absent schemas, and templated
  server URLs are common; every degradation path (fallback identity, open
  schemas, ignored servers) warns in the sync result instead of failing,
  and hand-edits let Toolsmith repair the worst rows in place.
- **Spec drift between syncs**: a stale template fails server-side with the
  service's own error; the teaching error names the resync route.
  Acceptable for v1, same stance as MCP.
- **Injection via spec text**: bounded by the secret-ref strip, the single
  pinned baseUrl, description caps, http fencing, and default no-grant with
  the no-write specialist recommendation in the group description.

## Rollout

Merge to main via `scripts/merge-branch.sh` (bump happens on main; feature
branches never touch version fields). Do NOT push, tag, or roll any box;
release and deploy are Jason's call. The jackdaw phase lands in its own repo
afterwards and reaches clients on the next pin bump. Write the result back
to the dev brain per the mantle-status skill (roadmap task, working-memory
bullet).
