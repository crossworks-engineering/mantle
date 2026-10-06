---
title: Models
---

## Models

Models is a live catalogue of the models each provider offers, with context window, prices and modality. Use it to choose a model, then set that model on an agent, a worker or the embedding setup.

- Pick a provider, then search, filter by type and sort by name, context, input price, output price or newest.
- Open a model to see its context, max output, modality, price per million tokens and any other charges.
- Copy its id with the copy button. Paste the id where you set the model.
- Click **Refresh model list** if a provider has just added a model.
- **Add to pool** saves a model to a curated pool. **Pools** and **Combos** are the other two views.

Compare three things: the context window (can a long document fit in one call), the input and output prices, and the modality (can it read images).

## Assistant

The assistant cannot change which model an agent uses. Specialists that hold the model curation tools can answer:

- "Which models have the largest context window?"
- "Add this model to the cheap chat pool."

## Technical

- The list is fetched from each provider and cached on the server for 5 minutes. **Refresh model list** skips the cache.
- A provider with no API key shows no list until you add one on the API keys screen.
- Agents and workers store a provider and a model id as text. Copy the id rather than retyping it, since a typo only shows up as a failed call.
- Tools: `model_catalog`, `model_pool_list`, `model_pool_set`, `model_pool_remove`.
