# Toolsmith: the API integration specialist

Toolsmith turns "here are the Mapbox docs, give my assistant travel
times" into a deployed capability in one prompt. It's a manifest
specialist (like Pages and Ledger) whose trade is the tool registry:
it reads a service's API documentation, authors templated HTTP tools
against it, proves them against the live API, and grants them to an
agent, at which point chat turns _and_ heartbeat routines can call
them.

**Safety switch.** A single-owner brain trusts itself, so by default an
authored tool is usable as soon as it's granted. If you grant
tool-authoring to an agent that reads untrusted content (email, web
pages), turn on **Settings → Tools → "Require my approval for
agent-built tools"**: every agent-authored tool then starts
confirm-gated; each call parks for your approval until you clear
"requires confirm" for that tool, so an injected agent can't silently
stand up an exfiltration endpoint. Independent of this switch: an agent's
own call that grants a group to itself is refused (on a turn that read a
client's text the call parks before the tool runs, and a person decides
with the warning on the card), an agent can't clear a tool's confirm gate
via update, a group takes only existing http and recipe tools, and
`web_fetch` can't reach private/internal/metadata addresses.

```
user prompt ("read <docs url>, build me routing tools")
   └─→ Toolsmith
         ├─ web_fetch        : read the API docs (parser HTML→text, paged)
         ├─ api_key_refs     : find the {{secret:service/label}} vault ref
         ├─ tool_group_ensure        : the INTEGRATION: service + base URL +
         │                            vault ref + where the credential goes
         ├─ api_docs_set     : store the docs on the group (searchable file)
         ├─ api_tool_create  : templates + input schema, with group_slug so the
         │                     base URL + credential are inherited
         ├─ api_tool_test    : real call through the agents' dispatcher
         ├─ api_skill_set    : distil the usage know-how into the group's skill
         └─ agent_grant_tool_group   : hand it to the assistant
```

## 0. The integration lives on the group

The binding layer (`tool_groups.integration`, migration `0137`) is what makes an
integration a _thing_ rather than a pile of tools that happen to hit the same
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
  `files/auto-filed/api-docs/<group-slug>.md` through the ordinary file pipeline, so it
  summarises, embeds, and FTS-indexes like any upload, every agent's
  `search_nodes` can find it. Adding endpoint #2 next month starts with
  `api_docs_get`, not a re-fetch of a page that may have moved or gone behind
  auth. `api_skill_set` then holds the _judgment_ (which call answers which
  question, unit conventions, chaining) and travels with the grant: an agent
  granted the group gets that skill in its context automatically
  ([tools-and-skills.md](tools-and-skills.md#integration-groups--a-group-that-is-an-api)).

Secrets don't move: `secretRef` is a `service/label` pointer and auth templates
hold the same `{{secret:…}}` refs the templates always used, resolved once in the
dispatcher. A credential-shaped literal in an auth template earns a warning
rather than being quietly stored in the clear, and neither a stored docs file nor
a usage skill may contain a key.

### OAuth2 client credentials

Some APIs do not take a fixed key. They hand out short-lived bearer tokens in
exchange for a client id and a client secret (OAuth2 client credentials, RFC
6749 section 4.4). A group declares that with `oauth2`:

```jsonc
// tool_group_ensure input
{
  "slug": "acme-tools",
  "service": "acme",
  "base_url": "https://api.example.com/v1",
  "oauth2": {
    "token_url": "https://auth.example.com/oauth/token", // https only
    "client_id_ref": "acme/client-id", // vault refs, never plaintext
    "client_secret_ref": "acme/client-secret",
    "scope": "read write", // optional
    "audience": "api://acme", // optional
    "client_auth": "basic", // or "body"; default basic
  },
}
```

When `auth_template` is unset it defaults to
`{ "headers": { "Authorization": "Bearer {{oauth:acme-tools}}" } }`, so tools
authored into the group (and OpenAPI connector tools) inherit the token
placement like any other credential. `{{oauth:<group-slug>}}` is a template ref
like `{{secret:…}}`: it resolves only in the author's templates, never from
model input. `oauth2: null` removes the config.

At call time the dispatcher (`packages/tools/src/oauth2-client-credentials.ts`):

- reads both credentials from the vault and posts
  `grant_type=client_credentials` to `token_url` through `safeFetch`, so the
  token URL meets the same egress rules as every api-tool call;
- keeps the token **in process memory only**, never in the DB, a log or a
  trace, until a safety margin before `expires_in` (a tenth of the lifetime,
  at most a minute; five minutes when the provider sends no expiry). The cache
  key hashes the config and the secret, so a rotated secret gets a new token;
- runs **one fetch at a time per group** (single-flight), so parallel calls
  share one token request;
- on a **401** from the API, replaces the token once and retries once;
- sends the token **only to the `base_url` origin**: a request to any other
  origin is refused before anything is sent, which is why `oauth2` needs
  `base_url`;
- scrubs the token, the client id and the secret from every result and error,
  and passes on only the RFC `error` / `error_description` fields of a failed
  token response, never the raw body.

The owner sees and can correct all of it at **Settings → Tool groups**: service,
base URL, credential, stored docs (view/replace), and a link to the usage skill.

When the service publishes an **OpenAPI 3.x spec**, the whole authoring loop can
be skipped: an [OpenAPI connector](./openapi-connectors.md) compiles selected
operations into http tools in its own `openapi-<slug>` group, using this same
inheritance for base URL + auth. Toolsmith cannot author into or bundle from a
connector group (its sync owns membership), but MAY edit a mirrored tool's
definition; the edit is stamped and survives re-sync.

## 1. The two ways in

| Surface                            | Path                                                                              | Who pays for the LLM               |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| Main assistant delegation          | "add a weather API" (anywhere, incl. the /dev-tools Assist button) → invoke_agent | the agent's OpenRouter key         |
| **Claude Code / Desktop over MCP** | the same tool set registered on server/mcp                                        | **the user's Claude subscription** |

(The old third way, the API Console's own docked panel invoking Toolsmith
directly, was removed in v0.206: no surface pre-selects a specialist anymore;
the responder keeps its context and delegates.)

The MCP row is the power-user path: every `api_tool_*` / `api_docs_*` /
`api_skill_set` / `tool_group_*` / `agent_*` / `web_fetch` / `api_key_refs` tool is
registered on the MCP server straight from the same `TOOLSMITH_TOOLS`
definitions (server/mcp/src/server.ts registers the array through a
JSON-Schema→zod bridge, so the surfaces cannot drift). A Claude Code
session connected to Mantle's MCP server can run the whole
read-docs → author → test → grant loop with no Mantle-side LLM spend.

**Scoping the MCP surface.** The read-only tools (`api_tool_list` /
`api_tool_get` / `tool_group_list` / `agent_list` / `api_key_refs` /
`api_docs_get` / `web_fetch`) are always exposed, and so is `api_tool_test`,
which is no read: it runs the tool, side effects included. The mutating
set, authoring (`api_tool_create` / `_update` / `_delete`), grouping
(`tool_group_ensure`), the integration writes (`api_docs_set` /
`api_skill_set`), granting (`agent_grant_tool_group`) and an agent's
thinking effort (`agent_set_thinking_effort`), is
gated on **`MANTLE_MCP_TOOLSMITH_WRITE`**, which defaults **on**. Set it
to `0` / `false` / `off` on a shared or headless deployment to keep tool
authoring + granting to the in-app agent while still letting an MCP
client browse and test the registry.

## 2. The tool set (packages/tools/src/builtins-toolsmith.ts)

- `web_fetch(url, offset?, max_chars?)`, fetch a docs page; HTML goes
  through the parser service's markup reader ([parser.md](parser.md)),
  long pages are read in slices via `offset`.
- `api_tool_list / api_tool_get`, browse the registry.
- `api_tool_create / api_tool_update`, author **http tools only**
  (shell tools stay human-authored; agents can never mint arbitrary
  command execution). Returns `warnings` when a `{param}` isn't
  declared in the input schema or a `{{secret:…}}` ref has no vault
  entry, so the agent self-corrects in the same turn. At call time an
  input field the caller left out is filled from its input-schema
  `default` before templating, so an optional `{param}` with a default
  (a page size, say) never silently drops off the request.
- `api_tool_delete`, user-defined tools only (built-ins refuse).
- `api_tool_test(slug, input)`, executes through the real
  `dispatchTool` (templating + vault secrets + timeouts). Refuses
  non-http targets: "testing" a shell tool would otherwise be an
  unconfirmed execution side-channel. On a tool with `requires_confirm` on,
  an in-brain agent's `api_tool_test` or `recipe_tool_test` waits in /pending
  and runs once on approval; a person in the console and an MCP client run it
  at once; an app is refused. A tool with no flag runs at once.
- On a brain on workspaces, a template that sends a vault key (a
  `{{secret:…}}` or `{{oauth:…}}` ref, or an OAuth2 group's token URL or base
  URL) is the keys area's: creating, updating or testing such a tool needs
  it, and a tool written by a login other than the brain owner resolves its
  refs at run time only while that login holds it (tools.created_by,
  `packages/tools/src/secret-ref-gate.ts`). The same rule covers every place
  a vault key meets a host: an integration group's secret ref, auth template
  or OAuth2 credentials against its base URL or token URL
  (`tool_group_ensure`, the tool-groups PATCH route), OpenAPI and MCP
  connectors (an OpenAPI connector's spec URL counts as part of its host,
  base URL or not), the API Console proxy, a mail account's stored password
  against its IMAP and SMTP host and port, and model routes (an agent's, an
  AI worker's or the embedder's route with a base URL other than the
  provider's: its key id, or with none the provider's vault key it falls back
  to). Setting or changing either side while the other is present needs the
  keys area or the anchor login (a mail account may instead re-enter its
  password). A group, connector or model route records who paired them
  (tool_groups, agents, ai_workers and embedding_config.configured_by); a
  tool authored into the group, or synced by an OpenAPI connector, takes that
  login as its maker, and an MCP connector's key, or a model route's key on
  its base URL, goes out only while that login holds the keys area. A synced
  spec path that is not relative (`https://...`) is not compiled, so every
  synced tool stays under the connector's base URL.
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
  never mistaken for a retryable failure. `_set` refuses a group with no
  integration: bind it with `tool_group_ensure` first.
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
- `agent_set_thinking_effort`, set one agent's thinking effort (`inherit`,
  `off`, `low` to `max`; see [thinking.md](thinking.md)). Same guards as a
  grant: no change to the calling agent itself, and an agent asking waits at
  /pending for the operator.

## 3. Seeding + configuration

Manifest-driven like every specialist (server/web/lib/system-manifest):

- **New installs**: onboarding's `applyManifest` provisions the agent,
  the `toolsmith` tool group, and the builtin rows automatically.
- **Existing installs**: `ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:toolsmith`
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
says so), which parks an in-brain agent's calls in /pending for operator
approval; an MCP client acts at once. An agent may tighten a gate, never loosen
one: on `api_tool_update` an agent may send only `requires_confirm: true`,
`enabled: false` and `external_access: false`, and any other value is a
person's, in Settings > Tools (`packages/tools/src/person-only-acts.ts`).

Every tool that adds to a group's list asks one rule first
(`groupListRefusal`, `packages/tools/src/toolsmith/common.ts`):
`tool_group_ensure`, and `api_tool_update` with `group_slug`. A group takes only
http and recipe tools that exist, for every caller of the tools; a person's route
takes any tool. A slug no tool has is refused: the tool is made first.
`api_tool_create` makes an http tool with that slug, so it needs no such ask.

One rule, one door (`heldGroupDoor`): any Toolsmith write that changes what a
group gives its holders, on a group an assistant of another workspace than Admin
holds, asks the door once, for all the groups it changes. A group that does not
exist yet counts as changed: a new group under a name a grant already lists asks
too. The door reads who by the caller's entry, nothing else:

| Entry                                                            | At the door                                        |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `owner-web` (the dev tool console), `pending` (an approved call) | acts at once                                       |
| `mcp`                                                            | acts at once                                       |
| `turn`, `run`                                                    | waits in /pending; on approval it runs once        |
| `app`, `api-v1`, `api-v1-nested`                                 | refused: nobody waits with it, so no row is queued |

An app's tool call at the door gets that refusal, in its own run: only an app at
admin rules can declare one of these tools (team and contact rules refuse a
writing builtin first). A /api/v1 route runs only Table row tools today, so it
never reaches the door. A recipe step cannot reach it either: the authoring kit is
`recipe: { step: 'forbidden' }`, `api_skill_set` and `api_docs_set` included.

These ask: `tool_group_ensure` when it makes the group or changes the list, the
name, the description or the integration; `api_tool_create` and
`recipe_tool_create` when a group holds the new slug; `api_tool_create` and
`api_tool_update` joining a group; `api_tool_update` when it edits a definition of
a tool a group holds; `api_tool_delete` of a tool a group holds; `api_skill_set`,
as the usage skill rides in those assistants' prompts; `sandbox_publish` when it
makes or changes a group. A group holds a tool when its list names it, or names a
recipe that steps through it at any depth: a step resolves by slug at call time.
`api_docs_set` has no door: it changes nothing a holder gets. It refuses a group
with no integration: `tool_group_ensure` binds one, through the door.

"Held" means an assistant with a workspace other than Admin names the group in its
own grant. A shared delegate and a skill held directly are not counted.

A tool may name another group's oauth (`{{oauth:<group-slug>}}`) at call time: no
check stands there.

`sandbox_exec` can change the service behind a published port, and with it what a
group's holders get. It has no door: anyone who may run a command there may change
that service by hand.

A tightening does not
wait: an agent's `requires_confirm: true`, `enabled: false` or
`external_access: false` with no definition edit goes on at once. A person's own
edit in Settings is unchanged.

With "require approval for agent-built tools" on, a definition edit by anything
but a person turns `requires_confirm` back on, as a new tool starts gated. A
person's approved call does not: the person looked at the whole call.

A delete takes the tool's name out of every group list, by hand too. A tool made
again under that slug is in no group until it joins through the door.

`api_tool_update` with `group_slug` alone adds the tool to the group. The
group's auth placement folds in only when the same call changes a definition
field, and its base URL only with a relative `url`.

The boot seed writes builtin rows only. A tool of another kind that holds a
builtin's slug stays as it is and the seed logs it.

With "require approval for agent-built tools" (`toolsmithRequireApproval`) off,
the owner trusts agents to make tools. So an agent may delete a gated tool and
make it again with no gate. Turn that setting on if you want a person to clear
every new tool.

See also: [`api-console.md`](./api-console.md) (the console surface +
HTTP templating contract), [`tools-and-skills.md`](./tools-and-skills.md)
(groups + grants), [`connecting-claude.md`](./connecting-claude.md)
(wiring Claude Desktop/Code to the MCP server).
