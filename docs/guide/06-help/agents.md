---
title: Agents
toolGroups: [toolsmith]
---

## Agents

Agents are the AI helpers that hold conversations. Each one has a prompt, a model, tool groups, skills and other agents it can hand work to.

Your main assistant is the persona. The others are specialists, such as the researcher for web search or the toolsmith for new tools. The persona calls them and folds their answer into its reply.

- Click **New**, or open an agent to edit it. Use **Duplicate** to copy one.
- **General**: name, slug, description, avatar and role.
- **Model & routing**: provider, API key, model, thinking effort and a **Backup route**. Turn on **Enable failover** so the backup takes over when the primary fails. **Make backup primary** swaps the two.
- **Behaviour**: **System prompt**, **Tool groups**, **Skills** and **Delegates to**.
- **Memory**: how many past turns, digests, facts and content hits each turn carries.

The **Models** tab changes the model of several agents at once.

## Assistant

- "What agents do I have?"
- "Give the researcher access to my files."
- "Use more thinking effort for the researcher."

The persona passes these to the toolsmith specialist. No agent can change a prompt or a model from chat. Edit prompts here or in Studio.

## Technical

- An agent can use exactly the tools in its tool groups. Skills teach behaviour and add no tools.
- The backup route takes over when the primary is down, rate-limited or returns a server error.
- Deleting an API key leaves its agents in place with no key set.
- Tools: `agent_list`, `agent_grant_tool_group`, `agent_set_thinking_effort`, `tool_group_list`.
- More: [Agents and AI workers](../03-using-jackdaw/13-agents.md).
