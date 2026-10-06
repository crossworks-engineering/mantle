# Agents, skills and tools

An agent is an assistant, a tool is an action it can take, and a skill is know-how it follows. All agents share one brain.

## Agents

An agent has a name, a personality, a model, the tool groups it may use and the skills it follows. Each agent keeps its own conversation, but reads the same memory.

- **The assistant** is the one you talk to, in Jackdaw and on Telegram.
- **Specialists** do one job well, for example Researcher (cited web answers), Toolsmith (builds tools for outside APIs) and Appsmith (builds apps). The assistant hands them work and uses the result. This is called delegation.
- **AI workers** run in the background. They summarise, pull out facts, transcribe voice and read images. You never talk to them.

## Tools

On its own an agent can only talk. Tools let it act: search memory, read a file, create a task, send an email, look something up on the web.

Tools come in **tool groups**, such as Notes or Calendar. An agent holds exactly the tools in the groups you grant it, and nothing else. A tool that does something risky can need your approval first; its calls wait under **Pending**.

## Skills

A skill is a short playbook added to an agent's instructions, for example how to write a formatted document or a house style for replies. Skills shape how an agent behaves. They do not grant tools.

## Heartbeats

A heartbeat gives an agent a standing job on a schedule, such as "every Monday, run my weekly review". It remembers what it did last time and stops itself when the goal is met.

## Example

You ask: "What is the weather in Lisbon this weekend, and add a packing task for Friday."

1. The assistant has no weather tool, so it delegates to Researcher, which searches the web and returns a cited forecast.
2. The assistant holds the Tasks group, so it creates the task itself.
3. It replies with the forecast, its source and the new task.

**Traces** shows each step, who did it and what it cost.

## Next

- [Agents and AI workers](../03-using-jackdaw/13-agents.md)
- [Skills and tools](../03-using-jackdaw/14-skills-and-tools.md)
- [Heartbeats](../03-using-jackdaw/15-heartbeats.md)
- Deep developer reference: [tools-and-skills.md](../../tools-and-skills.md)
