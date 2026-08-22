# Curated model pools + the Curator

The pools are advisory shortlists of models — one shared `agents` pool and one
per AI-worker kind (embedding excluded, it is the locked 768-dim singleton).
They power the picker comparisons ("$100 buys …") and never change what any
agent or worker actually runs; adopting a model stays an explicit settings
action.

## Two ways to curate

1. **By hand** — /models (the explorer) → open a model → *Add to pool* (copies
   the pricing snapshot in), then manage order/ratings/routes at /models/pools.
2. **By the Curator specialist** — delegate: "update the curated model pools".
   It reads live OpenRouter data and writes the pools:

| tool | what it reads/writes |
|---|---|
| `openrouter_rankings` | real token usage per model (top-50 daily dataset), window-aggregated, category/modality filters |
| `openrouter_benchmarks` | Artificial Analysis / Design Arena / OpenRouter eval scores |
| `openrouter_task_classes` | 7-day traffic share by task type + top models per task |
| `model_catalog` | slugs + live in/out $ per 1M (keyless, cached 5 min) |
| `model_pool_list` / `model_pool_set` / `model_pool_remove` | the curated_models store behind /models/pools |

Group `model-curation`, granted to the `curator` agent only (owner-side, never
the team responder). The Data API needs the owner's OpenRouter key
(30 req/min, 500/day — a curation pass uses a handful). Rankings data is
CC BY 4.0; the tools return the required attribution line.

## Data model

`curated_models` (migration 0152): an entry is the MODEL, not one slug —
`routes[]` carries a `{provider, model}` pair per way to reach it (the
OpenRouter slug and the vendor's direct slug differ), and `pricing` is a
curation-time snapshot so brains connected directly to a provider can still
render cost comparisons. Pool vocabulary: `packages/client-types/src/model-pools.ts`
(drift-tripwire test against the worker-kind enum).

## Roadmap context

Phase plan lives on dev-brain task `2ae9fce8`: curator (done) → owner curates →
repo-shipped template export (`GET /api/model-pools/export`) → picker
integration in the Agents Models tab + /settings/ai-workers → named full
combinations.
