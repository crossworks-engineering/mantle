# Toolsmith: the API integration specialist

Toolsmith turns "here are the Mapbox docs, give my assistant travel
times" into a deployed capability in one prompt. It's a manifest
specialist (like Pages and Ledger) whose trade is the tool registry:
it reads a service's API documentation, authors templated HTTP tools
against it, proves them against the live API, and grants them to an
agent, at which point chat turns *and* heartbeat routines can call
them.

**Safety switch.** A single-owner brain trusts itself, so by default an
authored tool is usable as soon as it's granted. If you grant
tool-authoring to an agent that reads untrusted content (email, web
pages), turn on **Settings → Tools → "Require my approval for
agent-built tools"**: every agent-authored tool then starts
confirm-gated; each call parks for your approval until you clear
"requires confirm" for that tool, so an injected agent can't silently
stand up an exfiltration endpoint. Independent of this switch, three
guards are always on: an agent can't grant a group to itself, can't
lower a tool's confirm gate via update, and `web_fetch` can't reach
private/internal/metadata addresses.

```
user prompt ("read <docs url>, build me routing tools")
   └─→ Toolsmith
         ├─ web_fetch        — read the API docs (Tika HTML→text, paged)
         ├─ api_key_refs     — find the {{secret:service/label}} vault ref
         ├─ tool_group_ensure        — the INTEGRATION: service + base URL +
         │                            vault ref + where the credential goes
         ├─ api_docs_set     — store the docs on the group (searchable file)
         ├─ api_tool_create  — templates + input schema, with group_slug so the
         │                     base URL + credential are inherited
         ├─ api_tool_test    — real call through the agents' dispatcher
         ├─ api_skill_set    — distil the usage know-how into the group's skill
         └─ agent_grant_tool_group   — hand it to the assistant
```

## 0. The integration lives on the group

The binding layer (`tool_groups.integration`, migration `0137`) is what makes an
integration a *thing* rather than a pile of tools that happen to hit the same
host. One group carries the service, its base URL, which vault entry
authenticates it, WHERE that credential goes, the API's documentation, and a
short usage skill. Two payoffs:

- **Author once, inherit forever.** `api_tool_create`/`_update` take
  `group_slug`: a relative `url` is joined onto the group's base URL and the
  group's `authTemplate` merges **under** the tool's own headers/query (the tool
  wins on a key conflict; header conflicts match case-insensitively so a call
  never carries two spellings of `Authorization`). This resolves **at authoring
  time** into the stored handler; the dispatcher is untouched, every tool
  authored before this feature still runs byte-identically, and `api_tool_get`
  shows exactly what will fire. The result reports what was inherited.
- **The knowledge doesn't evaporate.** `api_docs_set` stores the documentation as
  `files/api-docs/<group-slug>.md` through the ordinary file pipeline, so it
  summarises, embeds, and FTS-indexes like any upload, every agent's
  `search_nodes` can find it. Adding endpoint #2 next month starts with
  `api_docs_get`, not a re-fetch of a page that may have moved or gone behind
  auth. `api_skill_set` then holds the *judgment* (which call answers which
  question, unit conventions, chaining) and travels with the grant: an agent
  granted the group gets that skill in its context automatically
  ([tools-and-skills.md](tools-and-skills.md#integration-groups--a-group-that-is-an-api)).

Secrets don't move: `secretRef` is a `service/label` pointer and auth templates
hold the same `{{secret:…}}` refs the templates always used, resolved once in the
dispatcher. A credential-shaped literal in an auth template earns a warning
rather than being quietly stored in the clear, and neither a stored docs file nor
a usage skill may contain a key.

The owner sees and can correct all of it at **Settings → Tool groups**: service,
base URL, credential, stored docs (view/replace), and a link to the usage skill.

## 1. The two ways in

| Surface | Path | Who pays for the LLM |
|---|---|---|
| Main assistant delegation | "add a weather API" (anywhere, incl. the /dev-tools Assist button) → invoke_agent | the agent's OpenRouter key |
| **Claude Code / Desktop over MCP** | the same tool set registered on apps/mcp | **the user's Claude subscription** |

(The old third way, the API Console's own docked panel invoking Toolsmith
directly, was removed in v0.206: no surface pre-selects a specialist anymore;
the responder keeps its context and delegates.)

The MCP row is the power-user path: every `api_tool_*` / `api_docs_*` /
`api_skill_set` / `tool_group_*` / `agent_*` / `web_fetch` / `api_key_refs` tool is
registered on the MCP server straight from the same `TOOLSMITH_TOOLS`
definitions (apps/mcp/src/server.ts registers the array through a
JSON-Schema→zod bridge, so the surfaces cannot drift). A Claude Code
session connected to Mantle's MCP server can run the whole
read-docs → author → test → grant loop with no Mantle-side LLM spend.

**Scoping the MCP surface.** The read-only tools (`api_tool_list` /
`api_tool_get` / `api_tool_test` / `tool_group_list` / `agent_list` /
`api_key_refs` / `api_docs_get` / `web_fetch`) are always exposed. The mutating
set, authoring (`api_tool_create` / `_update` / `_delete`), grouping
(`tool_group_ensure`), the integration writes (`api_docs_set` /
`api_skill_set`), and granting (`agent_grant_tool_group`), is
gated on **`MANTLE_MCP_TOOLSMITH_WRITE`**, which defaults **on**. Set it
to `0` / `false` / `off` on a shared or headless deployment to keep tool
authoring + granting to the in-app agent while still letting an MCP
client browse and test the registry.

## 2. The tool set (packages/tools/src/builtins-toolsmith.ts)

- `web_fetch(url, offset?, max_chars?)`, fetch a docs page; HTML goes
  through the Tika container (crude tag-strip fallback), long pages are
  read in slices via `offset`.
- `api_tool_list / api_tool_get`, browse the registry.
- `api_tool_create / api_tool_update`, author **http tools only**
  (shell tools stay human-authored; agents can never mint arbitrary
  command execution). Returns `warnings` when a `{param}` isn't
  declared in the input schema or a `{{secret:…}}` ref has no vault
  entry, so the agent self-corrects in the same turn.
- `api_tool_delete`, user-defined tools only (built-ins refuse).
- `api_tool_test(slug, input)`, executes through the real
  `dispatchTool` (templating + vault secrets + timeouts). Refuses
  non-http targets: "testing" a shell tool would otherwise be an
  unconfirmed execution side-channel.
- `api_key_refs`, vault entries as `{{secret:service/label}}` refs,
  masked previews only; plaintext never leaves the dispatcher.
- `tool_group_list / tool_group_ensure`, capability bundles, with
  which-agents-grant-this backrefs. `tool_group_ensure` also sets the
  **integration** binding (`service`, `base_url`, `secret_ref`,
  `auth_template`); a `secret_ref` with no vault entry warns rather than
  failing, mirroring `api_tool_create`.
- `api_docs_set / api_docs_get`, store and read an integration's
  documentation. `_get` is paged like `web_fetch` and returns
  `has_docs: false` (not an error) when nothing is stored, so "no docs" is
  never mistaken for a retryable failure.
- `api_skill_set(group_slug, body)`, write the group's usage skill
  (`api-<group-slug>`). The **only** skill-authoring tool in the codebase, and
  deliberately the narrowest possible one: the slug is derived (no `slug`
  parameter, no update-by-id), a group with no integration is refused, and a
  skills row under that slug which the integration doesn't already own is
  refused rather than overwritten, so an agent can never edit a persona or
  product skill. Hard character cap, plus a warning past ~320 words, because
  the body ships in every granted agent's prompt on every turn.
- `agent_list / agent_grant_tool_group`, read the agent roster, add a
  group to an agent's grants. The prompt instructs Toolsmith to ask
  the user which agent gets new capabilities rather than guessing.

## 3. Seeding + configuration

Manifest-driven like every specialist (apps/web/lib/system-manifest):

- **New installs**: onboarding's `applyManifest` provisions the agent,
  the `toolsmith` tool group, and the builtin rows automatically.
- **Existing installs**: `ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:toolsmith`
  (overwrite mode, re-applies the canonical prompt/model/grants).
- Model: `anthropic/claude-sonnet-4.6` via OpenRouter by default,
  `TOOLSMITH_MODEL` env to override at seed time, or edit the agent in
  /settings/agents. Tool authoring rewards a strong model, Sonnet-tier
  or up; the prompt+schema discipline falls apart on small models.
- Grants: `toolsmith` + `research` groups. Deliberately **not**
  memory-core; it works from docs and the registry, not the user's
  brain.
- The Assist panel's agent is configurable per-surface (the picker in
  the panel header → `profiles.preferences.devToolsAssistAgentSlug`),
  mirroring the Pages/Tables pattern.

## 4. Trust model

Toolsmith can mint new capabilities and grant them to agents, that's
its job, and it's why the `toolsmith` tool group is granted ONLY to
the Toolsmith agent by default. Granting that group to a heartbeat-
driven agent would let unattended runs change the capability surface;
don't, unless that's explicitly what you want. Destructive remote
endpoints should be authored with `requires_confirm: true` (the prompt
says so), which parks calls in /pending for operator approval.

See also: [`api-console.md`](./api-console.md) (the console surface +
HTTP templating contract), [`tools-and-skills.md`](./tools-and-skills.md)
(groups + grants), [`connecting-claude.md`](./connecting-claude.md)
(wiring Claude Desktop/Code to the MCP server).
