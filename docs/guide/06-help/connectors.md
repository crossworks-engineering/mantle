---
title: Connectors
---

## Connectors

Point your brain at something another party runs and use it from your own
agents. Two kinds of connector share this screen:

- **MCP connectors** consume an external MCP server: its tools mirror into a
  group named `mcp-<slug>`.
- **OpenAPI connectors** consume a plain web API: you give the URL of its
  OpenAPI spec, pick which operations you want, and each becomes an ordinary
  HTTP tool in a group named `openapi-<slug>`.

Either way the result is a normal tool group you grant to an agent the same
way you grant any other.

This is the outward twin of Settings → MCP. That screen lets other AI clients
reach INTO your brain; this one lets your brain reach OUT: Firecrawl for
ad-hoc scraping, DeepWiki for questions about public GitHub repositories,
Power BI for questions about your organisation's reports, Open-Meteo for live
weather, or any MCP server or OpenAPI-described API.

Three ways a server can authenticate: not at all (public servers), with an API
key you store under Settings → API keys, or with OAuth, where you approve the
connection once in a browser tab and the brain refreshes tokens silently from
then on. When a refresh finally dies the connector shows "needs reconnect" and
one click re-runs the approval.

Some servers sign in through Microsoft, Power BI among them. Microsoft does
not let apps register themselves, so these connectors borrow the Microsoft
app you already set up under Settings → Microsoft. Your IT admin gives that
app the server's permissions, and adds this brain's connector callback URL
(the connectors screen shows it) as a Web redirect. If an approval ever
fails, the connector shows why, together with the fix.

The tool list is a mirror, refreshed only when you press Sync: connecting,
syncing, and granting are all deliberate acts, and nothing here runs on a
schedule.

For an OpenAPI connector you also choose WHICH operations become tools, by
spec tag or by picking them one by one; big APIs describe hundreds and every
tool costs prompt space on every turn, so there is a hard cap of 80 per
connector. Authentication is the same key-in-the-vault story as any
integration group: the spec never supplies a credential, you do. If you (or
Toolsmith) hand-tune one of the generated tools, the edit sticks; Sync
leaves edited tools alone unless you ask it to overwrite them.

## Assistant

- "Use Firecrawl to pull the pricing page off example.com and summarise it."
- "Ask DeepWiki how routing works in vercel/next.js."
- "In Power BI, what were last month's sales by region? The model id is in the report link."

Grant the connector's group to a research-style agent first. Results from an
external server are third-party content: the brain fences them as untrusted
before a model reads them, and the group description steers agents on when to
prefer the built-in web tools instead. Keep connector groups off the persona
and the team responder; a no-write specialist is the right holder.

## Technical

A connector is a `tool_groups` row whose `integration.mcp` binding carries the
endpoint URL, the credential pointer, and OAuth bookkeeping; there is no
separate connectors table. Remote tools materialise as `handler.kind='mcp'`
rows (slug `mcp_<connector>_<tool>`) and run through the normal dispatch
pipeline: SSRF-guarded egress with redirects refused, 25-second call timeout,
an 80k result cap, secret scrubbing, and an unconditional untrusted flag.

Credentials never sit on the row. A key connector stores a `service/label`
pointer into the encrypted vault; an OAuth connector seals its registration,
tokens, and PKCE verifier there under the connector's own slug, and deleting
the connector purges them along with the mirrored tools and every agent grant.

An OAuth connector can use a pre-registered app instead of registering
itself, for servers whose sign-in allows no self-registration.
`oauth.client` is `microsoft` (borrow the Settings → Microsoft app and sign
in at its tenant) or `manual` (an app registered by hand, sealed in the
vault). The details, including the Power BI setup, are in
`docs/mcp-connectors.md`.

Sync reconciles rather than replaces: tools that vanish from the remote server
are disabled, never deleted, so a grant can't silently shrink, and a tool that
returns is re-enabled with its history intact.

An OpenAPI connector works the same way with a different source: the spec is
fetched (SSRF-guarded, size-capped), compiled per operation into ordinary
`http` tools (provenance on `handler.openapi`), and reconciled by the same
disable-on-vanish rules; deselecting an operation counts as a vanish. Spec
text is treated as third-party: credential references are stripped from it
and per-operation server overrides are ignored, so every call goes to the
one base URL you set. Full detail lives in `docs/mcp-connectors.md` and
`docs/openapi-connectors.md`.
