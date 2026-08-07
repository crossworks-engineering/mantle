---
title: Models
---

## Models

A live catalogue of every model your providers currently offer, id, context
window, pricing, modality, searchable and sortable, one provider at a time.

This is a **reference screen, not a settings screen**. Nothing you do here
changes what your brain uses. It exists because choosing a model means comparing
real numbers that change weekly, and the alternative is a provider's marketing
page. Find the model you want, copy its id, then set it where it actually
applies: on an agent, a worker, or the embedding config.

The list is filtered by provider, free-text search and kind, and sorted by name,
context size or price. A refresh button re-pulls the provider's catalogue when
you suspect it's moved on.

## When to use this

Come here before changing a model anywhere else, and in particular before
changing one on a **worker**, where a wrong context window turns into truncated
summaries rather than an error you'd notice.

Three things are worth comparing every time. **Context** decides whether a long
document survives a single call. **Price** is quoted per million tokens for
prompt and completion separately, and the ratio between them matters more than
either number for a chatty workload. **Modality** tells you whether the model
can take an image at all, which is the usual reason an extraction worker
silently does nothing useful with a scanned PDF.

## Technical

The catalogue is fetched from each provider's own model endpoint and cached, so
the default view is fast and the refresh button is the escape hatch when a
provider has just published something. Providers that need a key show as
unavailable until one is set.

Pricing is normalised across providers into the same per-token shape, which is
what makes the sort meaningful, providers publish in different units, and some
carry extra line items (image input, cached reads, web search) that appear
separately on the detail pane rather than being folded into a single misleading
figure.

Model ids are copied verbatim because that is what the rest of the system stores.
An agent, a worker and the embedding config each hold a provider plus a model id
string; none of them validate it against this catalogue at save time, so a typo
surfaces as a failed call at run time. Copying beats retyping.
