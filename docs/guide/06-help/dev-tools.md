---
title: API Console
---

## API Console

The API Console runs Mantle's own interfaces by hand: every REST route, every MCP tool and every agent tool. Send a real request and read the real response.

- In **Library**, pick a call from **Built-in API**, **Built-in MCP** or **Agent tools**, or search for one.
- Fill in **Params**, **Headers**, **Body** and **Auth**. Tool calls take a form or JSON.
- Click **Send** (for HTTP) or **Run** (for tools). Read the result under **Body**, **Raw** or **Headers**.
- **Saved** and **History** keep your requests. You can also paste a cURL command.
- Click **Save as agent tool** to turn a working HTTP request into a tool.

Requests are real. A call that sends mail sends it, and a call that deletes deletes. Running a tool here counts as your approval.

## Assistant

The assistant cannot use this console. To build a tool from chat, ask for one and the toolsmith specialist will make it.

## Technical

- Agent tools run through the same dispatcher the agents use, as you, the owner.
- The MCP list is read live from the MCP server, so it shows what an outside client would see now.
- Saved requests, history and environments are kept in this browser only.
- In a saved tool, a `{{secret:service/label}}` reference stays a reference and is filled in at call time. A key typed in plain text is stored as is, so use a reference.
- A new tool reaches no agent until its group is granted. See [Toolsmith](../07-api/05-toolsmith.md).
