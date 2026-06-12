# API Console & Toolsmith — teach your assistant any API

This is Mantle's superpower for connecting to the outside world: **any
service with an HTTP API can become an ability your assistant uses** —
maps, weather, your accounting system, a courier tracker, an internal
company service. No code, no plugin marketplace, no waiting for an
integration to exist. There are two ways to build one: by hand in the
API Console, or by asking the **Toolsmith** agent to do the whole job
from the service's documentation.

## The idea in one example

You want your assistant to answer *"how long will it take me to drive
to the airport?"* Mantle doesn't know traffic — Mapbox does. So you:

1. Add your Mapbox token once under **Settings → API keys** (service
   `mapbox`, label `default`). It's encrypted at rest; nothing and
   no-one sees it again — tools reference it as
   `{{secret:mapbox/default}}` and the value is injected only at the
   moment a request is sent.
2. Get a `find_route` tool created (by hand or by Toolsmith — below).
3. Grant it to your assistant.

From then on it's just conversation: *"How long to the airport if I
leave at 4?"* — the assistant calls `find_route`, Mapbox answers, you
get a real number. And because **heartbeats run agents with the same
tools**, your morning-briefing routine can include live drive times
without any extra setup. Anything → ask → answered. That's the loop.

> **Hardening for untrusted input.** If you grant tool-authoring to an
> agent that reads email or web pages, turn on **Settings → Tools →
> "Require my approval for agent-built tools."** Every tool an agent
> builds then waits for your approval on each call until you clear
> *requires confirm* for it — so a prompt-injected agent can't quietly
> build and use an exfiltration tool. Off by default for simple
> single-owner setups.

## The API Console (System → API Console)

A built-in Postman. Three searchable catalogs, one request builder,
one response viewer:

- **Built-in API** — every REST endpoint Mantle ships, grouped, with
  example bodies. Fill the `{param}` chips and hit Send.
- **Built-in MCP** — the tools Claude Desktop/Code sees, listed live
  from the real MCP server and runnable in place.
- **Agent tools** — everything in your tool registry, executed through
  the exact dispatcher agents use. What works here works in an agent.

Build any HTTP request (method, URL, params, headers, body — with
`{{secret:…}}` refs for auth), test it, then **Save as agent tool**:
the `{placeholder}` values you used become the tool's inputs, you give
it a slug and a description the model will read, and it lands in the
registry ready to grant.

## Toolsmith — the agent that builds tools

The console's **Toolsmith** button opens an assistant panel. Give it a
prompt like:

> Read the Mapbox Directions docs at
> https://docs.mapbox.com/api/navigation/directions/ and build me a
> find_route tool that takes an origin and destination.

Toolsmith then does what an integration engineer would: reads the
documentation page, checks your key vault for the right
`{{secret:…}}` reference (and asks you to add the key if it's
missing — it never handles the raw value), writes the tool with a
proper input schema, **tests it against the live API**, fixes what
fails, bundles the result into a tool group, and asks which agent
should receive it. You watch the new tools appear in the console's
list as it works.

It manages the whole lifecycle too: ask it to list your tools, re-test
them, fix one after a service changed its API, or retire one safely.

## For Claude Code users (advanced)

The same Toolsmith toolkit is exposed over MCP. If you've
[connected Claude Code to your Mantle](../../connecting-claude.md),
you can run the identical loop from a Claude Code session — "read
these docs and build my Mantle a weather toolset" — on your Claude
subscription, with no Mantle-side model spend.

## Safety, in plain terms

- Agents can author **HTTP tools only** — shell/command tools remain
  yours to create by hand.
- API keys never appear in tool definitions, traces, or chat — only
  the `{{secret:service/label}}` reference does.
- Mark tools that *do* things on the remote side (delete, pay, send)
  as **requires confirmation** — calls then queue under **Pending**
  for your approval, like any gated tool.
- Granting is deliberate: a new tool does nothing until you (or
  Toolsmith, with your say-so) grant its group to an agent.

Deep dives: [`toolsmith.md`](../../toolsmith.md) (the specialist's
design), [`api-console.md`](../../api-console.md) (templating
contract + console internals), and
[Skills & tools](./02-skills-and-tools.md) for how grants work.
