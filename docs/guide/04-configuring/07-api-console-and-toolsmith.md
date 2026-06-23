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

## Toolsmith — let the AI build the integration for you

You don't have to build the request by hand. **Toolsmith** is the
specialist agent that reads a service's API docs and builds a working,
tested tool for you. There are two ways to reach it:

- **Just ask your assistant.** In chat (web or Telegram): *"Connect
  Mapbox and build me a tool that finds a driving route between two
  places — docs are at
  https://docs.mapbox.com/api/navigation/directions/."* The assistant
  hands the job to Toolsmith.
- **API Console → Toolsmith.** The console's **Toolsmith** button opens
  the same agent in a panel, right beside the catalogs and request
  builder.

### Building an integration, step by step

1. **Have the docs ready.** Find the service's API documentation URL —
   Toolsmith reads the page to learn the endpoint, parameters, and auth.
   (Name only the service and it will try to find the docs itself, but a
   URL is faster and surer.)
2. **Add the API key if the service needs one.** Most do. Store it once
   under **Settings → API keys**
   ([Keys & local models](./04-keys-embedding-local-models.md)) as a
   `service`/`label` pair. Toolsmith references it as
   `{{secret:service/label}}` and never sees the raw value — if the key
   is missing it stops and tells you exactly what to add.
3. **Describe what you want.** Give it the goal, the docs URL, and what
   the tool should take and return:
   > Read the Mapbox Directions docs at
   > https://docs.mapbox.com/api/navigation/directions/ and build a
   > `find_route` tool that takes an origin and destination and returns
   > the drive time and distance. Grant it to my assistant.
4. **Let it work.** Toolsmith writes the tool with a proper input
   schema, **tests it against the live API**, fixes what fails, and
   bundles the result into a tool group. You watch the new tools appear
   in the console's list as it goes.
5. **Approve and grant.** A freshly built tool does nothing until it's
   granted to an agent. Toolsmith asks which agent should receive it; if
   you've turned on approval for agent-built tools (below), the grant
   waits for you under **Settings → Pending**.
6. **Use it.** From then on it's just conversation — the agent calls the
   tool whenever it needs that data, including inside heartbeat routines.

### Writing a good request

- **Give the docs URL.** It's the single biggest factor in getting a
  correct tool on the first try.
- **Name the auth.** "Uses an API key" / "Bearer token" — and have the
  key stored first, so Toolsmith isn't blocked mid-build.
- **Say what goes in and what comes out.** "takes a city, returns the
  5-day forecast" beats "a weather tool."
- **Say who should get it.** The default is your main assistant; name
  another agent if a specialist or a heartbeat routine should use it.

Toolsmith manages the whole lifecycle too: ask it to list your tools,
re-test them, fix one after a service changed its API, or retire one
safely.

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
