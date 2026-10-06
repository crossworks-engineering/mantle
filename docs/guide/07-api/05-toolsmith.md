# Toolsmith

Toolsmith is the agent that reads an outside service's API docs, builds tools for it, tests them against the live API and grants them to an agent. You describe the goal; it does the work.

## Before you start

- The service's API documentation URL.
- If the service needs a key, store it under **Settings > API keys** as a service and label pair, for example `openweather` and `default`. Toolsmith refers to it as `{{secret:openweather/default}}` and never sees the value. If the key is missing, it stops and tells you what to add.

## Ask for a tool

1. Open the assistant in Jackdaw (or message it on Telegram).
2. Describe the goal, the docs and who should get the tool:

   > Read the OpenWeather docs at https://openweathermap.org/api and build a tool that takes a city and returns the 5-day forecast. Grant it to my assistant.

3. The assistant hands the job to Toolsmith. Toolsmith writes the tool, calls the real API, fixes what fails and puts the tools in a tool group for that service.
4. It asks which agent should get the group if you did not say.

From then on the agent calls the tool when it needs the data, in chat and in heartbeats.

## What a good request has

- **The docs URL.** It is the biggest factor in getting a correct tool first time.
- **The auth.** "Uses an API key" or "Bearer token", with the key already stored.
- **Inputs and outputs.** "Takes a city, returns the forecast" beats "a weather tool".
- **Who gets it.** Name the agent, or it asks.

Toolsmith also lists, retests, fixes and retires tools you already have. Ask it.

## From Claude Code

The same tools are on the MCP server: `api_tool_create`, `api_tool_test`, `tool_group_ensure`, `agent_grant_tool_group` and the rest. Connected Claude Code runs the whole loop on your Claude subscription, with no model cost on your Mantle ([Connect Claude over MCP](01-connect-claude.md)). To make these tools read only over MCP, set `MANTLE_MCP_TOOLSMITH_WRITE=0` on the server.

## Safety

- Agents build HTTP tools only. Shell tools stay yours to make by hand.
- Keys never appear in tools, traces or chat. Only the `{{secret:...}}` reference does.
- If an agent that reads email or web pages can build tools, turn on **Require my approval for agent-built tools** in **Settings > Tools**. Each call to a tool an agent built then waits under **Pending** until you clear its confirm setting.
- Toolsmith is told to mark tools that delete, pay or send as needing your approval.

## Use a ready-made MCP server instead

If the service already runs an MCP server, connect it under **Settings > Connectors** and press **Sync tools**. Its tools land in their own tool group, ready to grant ([Screen help: Connectors](../06-help/connectors.md)).

## Next

- [API console](04-api-console.md): build one tool by hand.
- [Skills and tools](../03-using-jackdaw/14-skills-and-tools.md)
