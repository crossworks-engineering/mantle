# Models and API keys

Add provider keys in **Settings > API keys**, then pick the model each agent and worker uses, with a backup route for when a provider fails.

## Add a key

One OpenRouter key covers chat, search embeddings, reading images and PDFs, voice and image generation. Add other providers only when you want to call them directly.

1. Open **Settings > API keys** and click **New**.
2. Pick the **Provider**, give the key a **Label** and paste the **Key value**.
3. Click **Save key**.
4. Select the key and click **Test**. It makes a free call to check the provider accepts it.

Keys are encrypted with the brain's master key. **Rotate** replaces a key's value in place, so everything that uses it keeps working.

## Pick models for agents

1. Open **Settings > Agents** and select an agent.
2. On the **Model & routing** tab, pick the provider, the model and the key.
3. Under **Backup route**, add a second provider and model, and switch it on.
4. Click **Save agent**.

The backup takes over when the primary is down, rate limited, out of credit or refuses its key. It can be a different model, so a local model can be primary with a cloud model behind it. **Make backup primary** swaps the two.

To move many agents to a new model at once, use the **Models** tab on the same screen. Changes wait until you click **Apply all**.

## Pick models for AI workers

Workers are the background jobs: the extractor that indexes new content, the summarizer, speech, vision and image generation. Set each one's model in **Settings > AI workers**, the same way as agents. Chat-type workers take a backup route too.

## Embedding

**Settings > Embedding** sets the one model that turns text into search vectors. The default is an online model on your OpenRouter or OpenAI key.

- A backup route here must use the same model, or old and new vectors do not match.
- **Test dimensions** checks a model's output size. The brain needs 768.
- After you change the model on purpose, click **Rebuild index** to embed everything again.

Change the embedding model only for a measured reason. A rebuild re-embeds every item and costs money on an online model.

## Compare models

**Models** in the menu lists the provider catalogue with context size and price. Add the ones you like to a pool to compare them. Pools never change what an agent runs.

## Check it worked

Send the assistant a message, then open the turn in **Traces**. Each model step names the model that answered.

## Next

- [Local models](06-local-models.md)
- [Agents and AI workers](../03-using-jackdaw/13-agents.md)
