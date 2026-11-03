---
title: Models
toolGroups: [model-curation]
---

## Models

Models helps you pick the model each agent and worker runs. It has three views, switched at the top of the list: **Explorer**, **Pools** and **Combos**.

**Explorer** is a live catalogue of the models each provider offers, with context window, prices and modality.

- Pick a provider, then search, filter by type and sort by name, context, input price, output price or newest.
- Open a model to see its context, max output, modality, price per million tokens and any other charges.
- Copy its id with the copy button. Paste the id where you set the model.
- Click **Refresh model list** if a provider has just added a model.
- **Add to pool** saves the model to a curated pool, with its prices.

Compare three things: the context window (can a long document fit in one call), the input and output prices, and the modality (can it read images).

**Pools** are shortlists of good models for each job, grouped under **Agents** and **Workers**. In a pool you can rate a model, move it up or down, edit or remove it, or **Add manually**. **Export template** copies the pools as a template. **Re-curate** ranks every pool again from live catalogue, benchmark and traffic data. It calls no model, so it costs no tokens. **Preview** shows the new shortlist first, and **Apply to my pools** replaces every pool with it.

**Combos** turn the pools into one choice. Each combination picks a model from every pool. Pick one, untick any agent or worker you want to leave alone, click **Apply** (the button names the combination) and confirm. This changes what those agents and workers run from their next turn. Nothing changes until you apply, and you can switch any of them back in Settings.

## Assistant

The assistant cannot change which model an agent uses. Specialists that hold the model curation tools can answer and edit the pools:

- "Which models have the largest context window?"
- "Add this model to the cheap chat pool."

## Technical

- The list is fetched from each provider and cached on the server for 5 minutes. **Refresh model list** skips the cache.
- A provider with no API key shows no list until you add one on the API keys screen. A provider marked **(no catalog)** has no list to fetch.
- **Microsoft Foundry** (Azure AI Foundry and Azure OpenAI) is a provider of its own, `foundry`. Its model id is your deployment name. With `MANTLE_FOUNDRY_ENDPOINT` set, the list comes from your Azure resource; without it, a fixed starting list shows. See [Models and API keys](../05-admin/05-models-and-keys.md).
- Agents and workers store a provider and a model id as text. Copy the id rather than retyping it, since a typo only shows up as a failed call.
- The pools are advisory: no curation tool changes what an agent or worker runs. Only **Apply** on Combos, or the agent's own settings, does that.
- Tools: `model_catalog`, `model_pool_list`, `model_pool_set`, `model_pool_remove`.
