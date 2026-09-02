# API integration groups: audit + implementation plan

> Handover plan (2026-07-26) for an implementing session (Opus 5) in a worktree
> (`scripts/new-worktree.sh api-integration-groups`). Goal: an agent can be
> handed API documentation and stand up a complete integration, a group that
> carries the docs and the credential; then any agent can later READ that
> stored documentation to add new calls to the same group. Acceptance demo
> (Jason runs it): give the agent a weather API's docs → it creates the group,
> stores the docs, binds the token, authors the first call → Jason asks in chat
> and gets a live forecast.

## Audit: what exists today (it's most of the machine)

| Piece | State |
|---|---|
| Specialist agent | **Toolsmith** (manifest, `isDelegate`): reads docs via `web_fetch`, authors templated `http` tools, tests via the real dispatcher, bundles + grants. Assist panel on `/dev-tools`; same 12 tools exposed over MCP. `docs/toolsmith.md` |
| Console | `/dev-tools`, three runnable catalogs (built-in API, MCP live-list, agent tools), request builder, *Save as agent tool*. `docs/api-console.md` |
| HTTP templating | `packages/tools/src/http-template.ts`, `{param}` from model input, `{{secret:service/label}}` from the vault at dispatch; plaintext never reaches model or browser; errors scrubbed |
| Vault | `api_keys` (service, label, encrypted, AAD=row id, masked previews); `api_key_refs` lists refs, never plaintext |
| Groups | `tool_groups`, slug/name/description/`toolSlugs[]`, granted to agents as a unit. Docstring: **"Capability-only: no instructions, no behaviour"** |
| Guards | agents author http/recipe only (never shell), can't self-grant, can't lower confirm gates, `web_fetch` blocks private/metadata addresses, optional "require approval for agent-built tools" |

## Audit: the two real gaps

1. **API documentation is not persisted.** Toolsmith fetches docs at authoring
   time and the knowledge evaporates. "Add the forecast endpoint next month"
   re-fetches a page that may have changed, moved, or sit behind auth, and a
   *different* agent has nothing at all. Nothing indexes the docs into the
   brain either, so "how do we call the weather API?" retrieves nothing.
2. **No service-level binding.** A group is a grant bundle, nothing more.
   Which vault ref an integration uses, where the auth goes (header vs query
   and under what name), and the base URL live only inside each authored
   tool's template. An agent adding call #2 must rediscover all three; get the
   secret ref wrong and the tool fails only at dispatch.

Non-gaps (don't rebuild): the authoring loop, the vault, the test path, the
grant path, the console. This plan adds a **binding layer**, not a new factory.

## Design decisions (defaults chosen; flag at merge if Jason disagrees)

1. **The "API group" IS a `tool_groups` row, extended**: one nullable jsonb
   column `integration` (`{ service, baseUrl?, secretRef?, authTemplate?,
   docsNodeId? }`). No second entity: a parallel `api_services` table would
   need its own CRUD/UI/grant story and every consumer would join the two.
   Manifest groups leave it null. The "capability-only" doctrine in
   `tool-groups.ts` means *no instructions/behaviour* (that's skills); static
   integration **configuration** doesn't cross that line, update the
   docstring + `docs/tools-and-skills.md` to say so explicitly.
2. **Docs are stored as a markdown FILE node** under `files.api-docs/
   <group-slug>.md` (created via the existing file pipeline), with the node id
   in `integration.docsNodeId`. Files auto-index (summary, embedding, FTS), so
   every agent's `search` can find the API's docs and cite them, Jason's "for
   the AI agents' own knowledge". NOT a `documentation` node: that type
   belongs to the disk-synced `doc_collections` worker and a web-authored doc
   has no disk root to reconcile against. NOT bare text on the group row:
   docs run tens of KB and would bloat every group list/grant read.
3. **`authTemplate` is a fragment, not a flag**: e.g.
   `{ "query": { "appid": "{{secret:openweathermap/default}}" } }` or
   `{ "headers": { "Authorization": "Bearer {{secret:x/default}}" } }`,
   merged into every call authored *into* the group unless the tool overrides
   the same key. This is the piece that makes "the token is selected in the
   group" real: auth placement is decided once, at group setup.
4. **Toolsmith stays the special agent.** No new agent. It gains the
   group-first workflow + two docs tools; the persona's `integrations` skill
   already routes "connect an API" to it.
5. **The group carries a usage SKILL (Jason, 2026-07-26).** An integration
   holds three kinds of knowledge: reference (the stored docs, read on
   demand), selection (tool descriptions, ~120-word budget), and **usage
   judgment**, which endpoint answers which question, unit conventions, how
   calls chain, how to read responses. The third had no home: skills attach
   to agents, so know-how never travelled with a grant. Now
   `integration.skillSlug` references a `skills` row (convention:
   `api-<group-slug>`), and the runtime includes granted groups' skills in
   context assembly: effective skills = agent's own ∪ skills of granted
   groups (deduped). Toolsmith DISTILLS the docs into this skill as its
   final authoring step, short (~150–250 words), per-tool sections where
   one call needs special handling. **No per-tool skill override** (each
   tool carrying its own instruction block is context bloat); per-tool
   sections inside the group skill cover that need, and a real override can
   be added later on the same mechanism if a case demands it. Docs must
   state plainly: the group *references* a skill; capability-only stays the
   rule for everything else.

## Phase 1: Schema + content layer

- Migration: `tool_groups.integration jsonb NULL`. Type + validation helper
  `parseIntegrationMeta` in `@mantle/content` (or `@mantle/tools`, put it
  beside the existing group helpers; it must be importable by both the API
  routes and the builtins). Validate `secretRef` shape (`service/label`),
  `authTemplate` only carries `headers`/`query` string maps, `baseUrl` is
  http(s).
- Helpers: `getGroupIntegration(ownerId, slug)`,
  `setGroupIntegration(ownerId, slug, meta)`; docs file create/replace helper
  that writes `files.api-docs/<slug>.md` through the normal file pipeline
  (auto-index) and returns the node id.

## Phase 2: Toolsmith tool surface (`builtins-toolsmith.ts`)

- **`tool_group_ensure` grows optional integration params**: `service`,
  `base_url`, `secret_ref`, `auth_template`, stored via
  `setGroupIntegration`. Warn (not fail) when `secret_ref` has no vault
  entry, mirroring the existing `api_tool_create` warning pattern.
- **`api_docs_set { group_slug, markdown, source_url? }`**: store/replace
  the group's API documentation file, link `docsNodeId`, prepend a
  provenance header (source URL + fetched date). Warn when the group has no
  `integration` yet.
- **`api_docs_get { group_slug, offset? }`**: read the stored docs back,
  paged like `web_fetch`. This is the tool a *future* authoring pass uses
  instead of re-fetching the internet. Description must teach the boundary:
  stored docs first, `web_fetch` only when there are none or they're stale.
- **`api_tool_create` / `api_tool_update` gain `group_slug`**: the authored
  tool is added to the group in the same call, and the dispatcher-visible
  template is built as: group `baseUrl` prefixes a relative `url`, group
  `authTemplate` merges under the tool's own headers/query (tool wins on key
  conflict). Inheritance resolves **at authoring time** into the stored
  handler; the dispatcher stays untouched, every existing tool keeps
  working, and `api_tool_get` shows exactly what will run. Report what was
  inherited in the result so the agent can see it.
- All descriptions per `packages/tools/CLAUDE.md`; they ship in system
  prompts, and `description-lint.test.ts` enforces the style.
- MCP surface: the new/changed tools ride `TOOLSMITH_TOOLS` automatically;
  `api_docs_set` is a mutation → gate it behind `MANTLE_MCP_TOOLSMITH_WRITE`
  with the other write tools.

## Phase 3: Toolsmith prompt + skills (manifest)

- `AGENT_PROMPTS['toolsmith']`: the workflow becomes **group-first**,
  (1) ensure the integration group: pick the vault ref with `api_key_refs`
  (ask the user which key if ambiguous, never guess between two), set
  `auth_template` + `base_url` from the docs; (2) `api_docs_set` the fetched
  docs; (3) author calls with `group_slug` so auth/base inherit; (4) test;
  (5) grant (still asks which agent). Adding to an EXISTING integration:
  `api_docs_get` first, `web_fetch` only if the stored docs don't cover the
  endpoint, and then `api_docs_set` the refreshed copy back.
- `integrations` skill (persona): mention that integrations carry their own
  stored docs + bound credential, so "add another endpoint to X" is also
  Toolsmith's job and needs no docs URL from the user.
- Manifest checklist per `system-manifest/CLAUDE.md` (prompt force-syncs to
  existing brains on upgrade; no new agent, no new groups to seed).

## Phase 4: Console + settings UI (`jackdaw`, modest)

- `/settings/tool-groups` group detail: an **Integration** section, service,
  base URL, secret ref picker (from the vault list, refs only), auth-template
  editor (header/query key + ref), docs status with view/replace (links to
  the file node). Editable by the owner; everything the agent can set, the
  owner can correct.
- `/dev-tools`: the agent-tools catalog groups by integration where one
  exists (group name + masked ref badge); "Save as agent tool" offers an
  optional integration-group picker that applies the same inheritance the
  builtin does. Keep it small; the console is a power surface, not the
  showcase.
- UI conventions per `jackdaw/docs/ui-style-guide.md` + `server/web/CLAUDE.md`
  non-negotiables.

## Phase 5: Verification

1. Unit: template-merge inheritance (tool overrides group on conflict; base
   URL join edge cases; secret-ref validation), `api_docs_set/get` round-trip,
   group-ensure integration params. `pnpm exec vitest run packages/tools
   packages/content` + description-lint.
2. Typecheck all touched workspaces; `pnpm verify` at the end.
3. Manual: none required here, Jason's weather demo IS the acceptance test
   (give Toolsmith a weather API's docs; it should produce group + stored
   docs + bound token + one working call, then answer a forecast in chat).
4. Docs: update `api-console.md`, `toolsmith.md`, `tools-and-skills.md`
   (groups may carry integration config; capability-only clarified).
   Changelog + bump per release cadence; tag-push is Jason's call.

## Non-goals

- No new agent (Toolsmith is the special agent) and no second entity beside
  `tool_groups`.
- No dispatcher changes, inheritance resolves at authoring time.
- No OpenAPI-spec ingestion/codegen; docs are stored prose the agent reads;
  a spec importer is a separate future feature.
- No auto-rotation or credential creation, keys still enter via
  Settings → API keys (never through an agent).
- Shell tools stay human-authored; every existing Toolsmith guard stays.
