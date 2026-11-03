---
title: Agents
toolGroups: [toolsmith]
---

## Agents

Agents are the AI helpers that hold conversations. Each one has a prompt, a model, tool groups, skills and other agents it can hand work to.

Your main assistant is the persona. The others are specialists, such as the researcher for web search or the toolsmith for new tools. The persona calls them and folds their answer into its reply.

- Click **New**, or open an agent to edit it. Use **Duplicate** to copy one.
- **General**: name, slug, description, avatar, role, priority and the **System prompt**.
- **Model & routing**: provider, API key, model and a **Backup route**. Turn on **Enable failover** so the backup takes over when the primary fails. **Make backup primary** swaps the two.
- **Tool groups**, **Skills** and **Delegation** (the agents it may hand work to).
- **Memory**: how many past turns, digests, facts and content hits each turn carries.

Two settings on **Model & routing** change how a turn runs:

- **Thinking effort**: how hard the agent reasons before it answers. **Inherit from profile** follows your profile. **Off** never reasons. A level overrides your profile for this agent.
- **Tool loading**: how the agent sees its tools. **Full** sends every tool on every call. **Deferred** sends a core set and the agent searches for the rest by name. **Map** sends a small core plus a map of the rest. **Default** picks for you: **Map** for an assistant, **Deferred** for an assistant on a Haiku model, **Full** for every other agent.

The **Models** tab changes the model of several agents at once.

## Assistant

- "What agents do I have?"
- "Give the researcher access to my files."
- "Use more thinking effort for the researcher."

The persona passes these to the toolsmith specialist. No agent can change a prompt or a model from chat. Edit prompts here or in Studio.

## Technical

- An agent can use exactly the tools in its tool groups. Skills teach behaviour and add no tools.
- The backup route takes over when the primary is down, rate-limited or returns a server error.
- Tool loading is `params.tool_loading` (`full`, `deferred` or `map`). An agent's own setting always wins over the default.
- Deleting an API key leaves its agents in place with no key set.
- Tools: `agent_list`, `agent_grant_tool_group`, `agent_set_thinking_effort`, `tool_group_list`.
- More: [Agents and AI workers](../03-using-jackdaw/13-agents.md).
