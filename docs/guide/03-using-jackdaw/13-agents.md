# Agents and AI workers

Change how your assistant thinks and sounds on **Settings > Agents**, and the background jobs on **Settings > AI workers**.

For what agents, skills and tools are, see [Agents, skills and tools](../04-concepts/02-agents-skills-tools.md).

## Agents

An agent is something that holds a conversation. You talk to the **Assistant**. The others are specialists it hands work to, for example **Researcher** (web search), **Pages** (documents), **Ledger** (tables), **Appsmith** (apps) and **Toolsmith** (new tools). The **Team Responder** answers your members.

### Edit an agent

1. Open **Settings > Agents** and click an agent.
2. Change what you need on its tabs:

| Tab | What you set there |
|---|---|
| **General** | Name, description, avatar, role, priority, and its **Telegram bot**. |
| **Model & routing** | Provider, API key and model; a backup route it falls back to; **Voice (TTS)**; **Thinking effort**. |
| **Behaviour** | **System prompt**, **Tool groups**, **Skills**, **Delegates to**. |
| **Memory** | How much past conversation and knowledge each turn carries; **Learned**, which links to its notes in the Journal. |

3. Save.

Points worth knowing:

- **Backup route**: an optional second model for when the primary is down. It can be a different provider, so a local model can run first with a cloud model behind it. **Make backup primary** swaps them.
- **Thinking effort**: **Inherit** follows your profile. **Off** to **Max** override it for this agent. Higher costs more per turn.
- **Tool groups** are the only way an agent gets tools. The **Effective tools** box shows the result. See [Skills and tools](14-skills-and-tools.md).

### Change many models at once

The **Models** tab shows every agent's provider, model and key. Pick a new set for one row, and the others offer to copy it with one click. Nothing saves until you click **Apply all**. Only the primary route changes.

### Add or delete an agent

Click **New** to add an agent. When you delete one, choose whether to keep or delete its chat.

## AI workers

Workers are one-shot background jobs with no conversation: the **Extractor** reads new content, the **Summarizer** folds old chat into digests, the **Reflector** runs on a timer, and others handle documents, images, voice and image generation.

- Each kind has one default worker. That is the one that runs.
- Each worker has its own model and key. Chat-based workers, such as the Extractor and Summarizer, can also have a backup route.
- Workers run every time content arrives, so they are where steady cost comes from. Check a model's context window on **Models** before you switch the Extractor to it.

Provider keys belong on **Settings > API keys**. See [Models and API keys](../05-admin/05-models-and-keys.md). To run models on your own machine, see [Local models](../05-admin/06-local-models.md).

## Next

- [Skills and tools](14-skills-and-tools.md)
- Screen help: [Agents](../06-help/agents.md), [AI workers](../06-help/ai-workers.md)
