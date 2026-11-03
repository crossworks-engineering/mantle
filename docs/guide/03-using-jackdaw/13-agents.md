# Agents and AI workers

Change how your assistant thinks and sounds on **Settings > Agents**, and the background jobs on **Settings > AI workers**.

For what agents, skills and tools are, see [Agents, skills and tools](../04-concepts/03-agents-skills-tools.md).

## Agents

An agent is something that holds a conversation. You talk to the **Assistant**. The others are specialists it hands work to, for example **Researcher** (web search), **Pages** (documents), **Ledger** (tables), **Appsmith** (apps) and **Toolsmith** (new tools). The **Team Responder** is a ready-made assistant to give a team's workspace.

### Edit an agent

1. Open **Settings > Agents** and click an agent.
2. Change what you need on its tabs:

| Tab                 | What you set there                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **General**         | Name, description, avatar, role, priority, its **Telegram bot** and the **System prompt**.                            |
| **Model & routing** | Provider, API key and model; a backup route it falls back to; **Voice (TTS)**; **Tool loading**; **Thinking effort**. |
| **Tool groups**     | The tool groups it holds, and the **Effective tools** they add up to.                                                 |
| **Skills**          | The skills it follows.                                                                                                |
| **Delegation**      | **Delegates to**: the agents it may hand work to.                                                                     |
| **Memory**          | How much past conversation and knowledge each turn carries; **Learned**, which links to its notes in the Journal.     |

3. Save.

Points worth knowing:

- **Backup route**: an optional second model for when the primary is down. It can be a different provider, so a local model can run first with a cloud model behind it. **Make backup primary** swaps them.
- **Thinking effort**: **Inherit from profile** follows your profile. **Off** to **Max** override it for this agent. Higher costs more per turn.
- **Tool loading**: how the agent sees its tools. **Full** sends every tool. **Deferred** sends a core set; the agent searches for the rest by name. **Map** sends a small core plus a map of the rest. On **Default**, an assistant runs **Map** (**Deferred** on a Haiku model) and every other agent runs **Full**.
- **Tool groups** are the only way an agent gets tools. The **Effective tools** box shows the result. See [Skills and tools](14-skills-and-tools.md).
- **Telegram bot**: any workspace's assistant can have a bot. Each chat with it belongs to the user who paired it with its code, and the assistant answers that user in their own chat, with what they may see in its workspace. Moderators and Admin users block or unpair chats; nobody pairs a chat for someone else. See [Connect Telegram](../02-first-steps/05-connect-telegram.md#who-a-paired-chat-acts-as).

### Change many models at once

The **Models** tab shows every agent's provider, model and key. Pick a new set for one row, and the others offer to copy it with one click. Nothing saves until you click **Apply all**. Only the primary route changes.

### Add or delete an agent

Click **New** to add an agent. When you delete one, choose whether to keep or delete its chat.

## AI workers

Workers are one-shot background jobs with no conversation: the **Extractor** reads new content, the **Summarizer** folds old chat into digests, the **Reflector** runs on a timer, and others handle documents, images, voice, image generation and web search. The **Decider** makes small typed choices, such as which passages fit a question.

- Each kind has one default worker. That is the one that runs.
- Each worker has its own model and key. Chat-based workers, such as the Extractor and Summarizer, can also have a backup route.
- Workers run every time content arrives, so they are where steady cost comes from. Check a model's context window on **Models** before you switch the Extractor to it.

Provider keys belong on **Settings > API keys**. See [Models and API keys](../05-admin/05-models-and-keys.md). To run models on your own machine, see [Local models](../05-admin/06-local-models.md).

## Next

- [Skills and tools](14-skills-and-tools.md)
- Screen help: [Agents](../06-help/agents.md), [AI workers](../06-help/ai-workers.md)
