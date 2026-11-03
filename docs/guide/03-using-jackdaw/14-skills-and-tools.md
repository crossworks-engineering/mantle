# Skills and tools

Control what each agent can do with tools and tool groups, teach it how with skills, and approve risky actions in **Pending**.

| Thing          | What it does                                                                                | Where                      |
| -------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| **Tool**       | One action, such as "send an email" or "query a table".                                     | **Settings > Tools**       |
| **Tool group** | A bundle of tools. Granting a group is the only way an agent gets tools.                    | **Settings > Tool groups** |
| **Skill**      | Written instructions that teach an agent how to do something well. A skill grants no tools. | **Settings > Skills**      |

An agent can do exactly what its tool groups hold. A skill about page editing without page tools teaches it to explain, not to edit.

## Give an agent a capability

1. Open **Settings > Tool groups** and find a group with the tools you need. To make one, click **New**, name it and pick its tools.
2. Open **Settings > Agents**, pick the agent, and go to **Behaviour**.
3. Add the group under **Tool groups**. The **Effective tools** box shows what the agent can now use.
4. Save.

The change applies from the agent's next turn.

## Gate a tool behind your approval

1. Open **Settings > Tools** and pick the tool.
2. Switch on **Requires operator confirm**, then save.

From now on, each call waits in **Pending**. Sending email is gated this way by default. Keep anything that sends, deletes or spends gated until you trust it.

The **Enabled** switch on a tool turns it off for every agent at once.

## How an assistant sees its tools

An assistant does not get every tool's full text on each turn. It gets a short core set of tools in full, plus a tool map: one short line per area that names every other tool it holds. When it needs one of those, it asks for that tool's details (`tool_help`) and calls it by name (`tool_call`). The map costs far less than the full list, and the gate checks each call the same way.

This map is the default for assistants. An assistant on a Haiku model gets a search over its tools instead, and other agents get the full list. To change it for one agent, set its `tool_loading` to `full`, `deferred` or `map` ([tools-and-skills.md](../../tools-and-skills.md#the-default-mode)).

## Approve or reject in Pending

The **Pending** menu item shows a count when something waits.

1. Open **Pending**.
2. Read the arguments, not only the tool name. They show what will actually happen, such as the recipient and text of an email.
3. Click **Approve & run** or **Reject**.

Background runs also stop here to ask you a question, or to ask for more budget. Answer in the small form shown.

Nothing in Pending has happened yet. Its history at the bottom shows what was decided.

## Write a skill

1. Open **Settings > Skills** and click **New**.
2. Fill in **Name** and **Description**, and write **Instructions (markdown)**. For example: "When you quote a price, show VAT on its own line."
3. Save, then attach it on the agent's **Behaviour** tab under **Skills**.

A skill change takes effect on the next message.

## Next

- [Heartbeats](15-heartbeats.md)
- Screen help: [Tools](../06-help/tools.md), [Tool groups](../06-help/tool-groups.md), [Skills](../06-help/skills.md), [Pending](../06-help/pending.md)
