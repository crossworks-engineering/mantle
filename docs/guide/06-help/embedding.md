---
title: Embedding
---

## Embedding

Embedding sets the one model that turns your content into vectors, so search can find things by meaning. There is one embedding setup for the whole brain.

- **Model**: the embedding model name.
- **Primary route**: the provider, base URL and API key. Click **Test dimensions** to check the model returns 768 numbers per vector.
- **Backup route (same model)**: turn on **Enable failover** to reach the same model another way.
- **Performance & throughput**: hardware profile, concurrency and batch size for indexing.
- Click **Save embedding config**.

Do not change the model without a reason. All vectors must come from the same model to be comparable. After a change, click **Rebuild index** to re-embed everything. Search is weaker until that finishes.

## Assistant

The assistant cannot change these settings. Set them here.

## Technical

- Every vector is stored at 768 dimensions. A model with another size cannot be used without a database change.
- The backup must be the same model, or its vectors would not match the index.
- Embeddings are cached by model and text, so unchanged text is never embedded twice. A new model invalidates the whole cache.
- With no setup, a local keyless model is used.
- See [Models and API keys](../05-admin/05-models-and-keys.md) and [Local models](../05-admin/06-local-models.md).
