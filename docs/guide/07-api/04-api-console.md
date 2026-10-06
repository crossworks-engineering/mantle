# API console

The API console runs any Mantle call in place, and turns an HTTP request to an outside API into a tool your agents can use. Open it at **System > API Console**.

## What the library holds

| List | What it is | How a call runs |
| --- | --- | --- |
| **Built-in API** | Every Mantle `/api/` route, with example bodies | As you, in the browser |
| **Built-in MCP** | The tools an MCP client sees, read live from the MCP server | Through the real MCP server |
| **Agent tools** | Every tool in your tool registry | Through the same dispatcher agents use |

Search matches names, paths, descriptions and parameter names. Pick a call, fill its `{param}` fields and press **Send** (or **Run** for a tool). The response shows on the right.

## Turn an outside API into an agent tool

Example: a driving-time tool on Mapbox.

1. Store the API key under **Settings > API keys**, with service `mapbox` and label `default`.
2. In the console, build the request. Put inputs in braces and the key as a secret reference:

   ```
   GET https://api.mapbox.com/directions/v5/mapbox/driving/{coords}?access_token={{secret:mapbox/default}}
   ```

3. Fill `coords` with test values and press **Send**. Fix it until the response is right.
4. Press **Save as agent tool**.
5. Give it a **Name**, a **Slug** (the function name the model calls) and a **Description** (the model reads it). The braced values become the tool's inputs.
6. Optional: pick an **Integration group** so the tool inherits that group's base URL and key.
7. Turn on **Requires operator confirm** for a tool that changes, pays or sends something. Each call then waits under **Pending**.
8. Press **Create tool**.

The key never reaches the model or the browser. Mantle fills `{{secret:mapbox/default}}` at call time and scrubs it from results.

## Give the tool to an agent

A new tool does nothing until an agent holds it. Add it to a tool group under **Settings > Tool groups**, then grant that group to the agent ([Skills and tools](../03-using-jackdaw/14-skills-and-tools.md)). Heartbeats run agents with the same tools, so a scheduled routine can use it too.

## Let the assistant build it

Press **Assist** in the request builder and describe the job, with the docs URL. The assistant hands it to Toolsmith, and the new tools appear in **Agent tools** when it finishes ([Toolsmith](05-toolsmith.md)).

## Next

- [Toolsmith](05-toolsmith.md)
- [Screen help: API Console](../06-help/dev-tools.md)
