# API Console — a built-in Postman + the custom-API-tool factory

The API Console (`/dev-tools`, sidebar → System → API Console) is two
things in one screen:

1. **An explorer for everything Mantle can already do** — every built-in
   REST route, every MCP tool (listed live from the real MCP server),
   and every agent tool, searchable and runnable in place.
2. **A factory for new agent abilities** — build an HTTP request against
   any external API, prove it works, then *Save as agent tool*. The
   request template becomes a `tools` row that agents (and therefore
   heartbeats) can call, with secrets pulled from the encrypted key
   vault at call time.

The flow that makes this special: **Heartbeat → Agent → your custom API
tool → response**. Add a Mapbox token, save a `find_route` tool, grant
it to an agent, and a daily-briefing heartbeat can include live travel
times — no code, no deploy.

```
API Console (build + test request)
   └─→ Save as agent tool  → tools row (kind: http, templated)
         └─→ tool group    → agent grant
               └─→ chat turn / heartbeat fire → dispatchTool()
                     └─→ {param} from model input + {{secret:…}} from vault
```

## 1. The three runnable catalogs

| Group | Source | Executed via |
|---|---|---|
| Built-in API | static catalog (`apps/web/lib/dev-tools/catalog.ts`) | browser fetch (session cookie) or server proxy |
| Built-in MCP | live `tools/list` from apps/mcp over stdio | `/api/dev-tools/mcp` bridge |
| Agent tools | `tools` table (`/api/tools`) | `/api/dev-tools/execute-tool` → `dispatchTool` |

The MCP group spawns the actual `apps/mcp` server on first use (the
same process Claude Desktop talks to), so the listing can never drift
from reality. The child idles out after 5 minutes.

Search matches names, paths, methods, descriptions, and **parameter
names** — typing `{id}` or `agentSlug` finds every call that carries it.

Saved requests + history live in localStorage; bearer tokens and
Authorization headers are blanked before persisting.

## 2. HTTP tool templating (the `http` handler, phase 5)

An `http` handler is now a request *template*:

```jsonc
{
  "kind": "http",
  "url": "https://api.mapbox.com/directions/v5/{profile}/{coords}",
  "method": "GET",
  "query":   { "access_token": "{{secret:mapbox/default}}" },
  "headers": { "x-team": "{team}" },
  "body":    "{\"note\": {note}}",     // optional
  "timeoutMs": 15000
}
```

Substitution rules (implemented in `packages/tools/src/http-template.ts`,
tested in `http-template.test.ts`):

- **`{param}`** fills from the model's tool-call input — URL-encoded in
  the URL, raw in query values + headers, **JSON-encoded in the body**
  (so write `"q": {query}`, not `"q": "{query}"`; strings arrive quoted).
- **`{{secret:service/label}}`** decrypts from the `api_keys` vault
  (Settings → API keys) inside the dispatcher. Plaintext never reaches
  the model or the browser; error text is scrubbed back to
  `[secret:service/label]`. Only refs written by the tool author
  resolve — a model passing a ref string as input gets a literal.
- **Spillover**: input fields no template consumed go to the JSON body
  (non-GET) or query string (GET). A handler with no templates at all
  behaves exactly like the legacy one: POST the whole input as JSON.

## 3. Granting and the heartbeat path

Saving a tool registers it; agents see it once it's in a granted tool
group (Settings → Tool groups → add slug → grant group to agent).
Heartbeat fires resolve the agent's tools the same way a chat turn
does, so no extra wiring — see [`heartbeats.md`](./heartbeats.md).

`requiresConfirm` works as everywhere else: the call parks in
`pending_tool_calls` for operator approval. Running a tool from the
console itself skips the queue — the operator pressing Run *is* the
confirmation.

## 4. Console plumbing (for the curious)

- `/api/dev-tools/proxy` — server-side fetch for cross-origin requests
  and anything carrying a `{{secret:…}}` ref (CORS-free, secrets stay
  server-side, response scrubbed + capped at 2MB).
- `/api/dev-tools/execute-tool` — runs a `tools` row through the real
  `dispatchTool`, so a console test exercises exactly what an agent
  call would.
- `/api/dev-tools/mcp` — GET lists / POST calls tools on the spawned
  MCP server (`apps/web/lib/dev-tools/mcp-bridge.ts`; override the
  location with `MANTLE_MCP_DIR` if your layout is exotic).

Security posture: every route sits behind `requireOwner()`. The proxy
is an intentional SSRF-by-design for the single owner — the same power
their `http` tools already have. Nothing new is network-exposed; the
MCP bridge stays stdio.

## 5. The Toolsmith Assist panel

The console's header has a **Toolsmith** button — an in-surface Assist
panel (same pattern as /pages and /tables) backed by the Toolsmith
specialist. Instead of building a request by hand, describe the
integration ("read the API docs at <url> and build tools for X") and
Toolsmith runs the whole loop: web_fetch the docs, author the
templates, test against the live API, bundle + grant. The same
capability is exposed over MCP for Claude Code users. See
[`toolsmith.md`](./toolsmith.md).
