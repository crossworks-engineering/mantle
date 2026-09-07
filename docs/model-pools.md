# Curated model pools + the Curator

The pools are advisory shortlists of models — one shared `agents` pool and one
per AI-worker kind (embedding excluded, it is the locked 768-dim singleton).
They power the picker comparisons ("$100 buys …") and never change what any
agent or worker actually runs; adopting a model stays an explicit settings
action.

## Two ways to curate

1. **By hand** — /models (the explorer) → open a model → _Add to pool_ (copies
   the pricing snapshot in), then manage order/ratings/routes at /models/pools.
2. **By the Curator specialist** — delegate: "update the curated model pools".
   It reads live OpenRouter data and writes the pools:

| tool                                                       | what it reads/writes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openrouter_rankings`                                      | real token usage per model (top-50 daily dataset), window-aggregated, category/modality filters                                                                                                                                                                                                                                                                                                                                |
| `openrouter_benchmarks`                                    | Artificial Analysis / Design Arena / OpenRouter eval scores                                                                                                                                                                                                                                                                                                                                                                    |
| `openrouter_task_classes`                                  | 7-day traffic share by task type + top models per task                                                                                                                                                                                                                                                                                                                                                                         |
| `model_catalog`                                            | the FULL catalog — chat, image + video generators, speech + transcription engines, embeddings, rerank — with slugs, live in/out $ per 1M and a `kind` read off `output_modalities` (keyless, cached 5 min), filterable by `kind`; plus the voice models reached through their own adapters. Pricing is null wherever the route is not token-billed (per-minute audio, per-second video, the adapter rows) — see the note below |
| `model_pool_list` / `model_pool_set` / `model_pool_remove` | the curated_models store behind /models/pools                                                                                                                                                                                                                                                                                                                                                                                  |

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

## Pool fit: readers vs generators

Every pool declares a `modality` contract (`packages/client-types/src/model-pools.ts`),
and `poolModelIssue(pool, modalities)` checks a candidate against it.

The reason it exists: **"Read images" and "Image generation" both accept image
input**, so the input side alone cannot tell them apart. On 2026-09-02 the
shipped vision pool carried Nano Banana Pro
(`google/gemini-3-pro-image`, `text+image->text+image`) — a generator. It
would have billed image-generation tokens and returned a picture where the
vision worker parses text. OpenRouter's `architecture.output_modalities` is
the decider: **an image reader is just a capable text-out model that accepts
pictures.**

Four write paths now check it, all fail-open (an unloaded or unreachable
catalog allows the write; only positive catalog evidence rejects):

| Path                               | File                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `model_pool_set` (the Curator)     | `packages/tools/src/builtins-curation.ts`               |
| `POST /api/model-pools` (hand-add) | `server/web/app/api/model-pools/route.ts`               |
| AI-worker save                     | `server/web/lib/ai-workers.ts` (`openRouterModelIssue`) |
| Vision model dropdown              | `packages/voice/src/adapters/openrouter-vision.ts`      |

A guard only protects the NEXT write. For rows that predate it — curated
entries, and models already saved on an agent or worker — the `pool-fit`
maintenance task reports the misfits and leaves the fixing to you
(`pnpm -C server/web models:pool-fit`, nightly on the cron sweep,
docs/maintenance-runner.md). It calls the same `poolModelIssue`, so the report
and the guards can never disagree.

`model_catalog` now returns `inputModalities` / `outputModalities` so the
Curator sees the evidence rather than guessing from the model's NAME, which
is how the bad entry got in. OpenRouter's meta-routers (`openrouter/auto*`)
are exempt on the worker path — their modalities are the union over
everything they might route to.

### The catalog fetch has to ask for the whole catalog

Both fetches (`refreshModelCatalog` in `packages/tracing/src/model-context.ts`,
which backs all the guards, and `loadCatalog` in the Curator's tools) append
**`?output_modalities=all`**. Without it OpenRouter returns the text-out slice
— 430 of 581 rows on 2026-09-07 — and the missing 151 are exactly the ones
the guards judge: 41 of the 52 image generators, all 28 video models, all 18
speech and all 20 transcription engines, plus embeddings and rerank. A model
the catalog does not list reads as UNKNOWN, and the guards fail open, so
`google/gemini-3-pro-image` was checkable while `black-forest-labs/flux.2-pro`
was not. Valid values: `text, image, embeddings, audio, video, rerank, speech,
transcription, all`.

Two consequences worth knowing:

- Speech and transcription routes publish `context_length: 0`. `parseCatalog`
  keeps them anyway (contextLength 0 = "no window published"); the context
  readers treat 0 as unknown and fall through to the static table.
- **A missing window also means the price is not per token**, and both fetches
  suppress per-1M pricing for those rows. OpenRouter reuses `pricing.prompt`
  for per-minute audio and per-second video rates: `openai/whisper-1`'s
  `"0.006"` is $0.006 per MINUTE, `deepgram/nova-3`'s `"0.0043"` likewise, and
  `microsoft/mai-transcribe-1.5`'s `"0.36"` would render as $360,000 per 1M
  tokens. Every windowed row prices between $1 and $16 per 1M, so the window is
  a clean discriminator — and it costs nothing, since embeddings and rerank all
  publish windows and no row in the text-out catalog lacks one. The token-billed
  voice routes (`openai/gpt-4o-mini-transcribe`, `x-ai/grok-voice-tts-1.0`)
  keep their real pricing; the rest report "unavailable", which preserves the
  "never invent a rate" contract that the old hand-written voice list had.
- The `tts` and `stt` pools are checked now. Their contract is OpenRouter's
  own `speech` / `transcription`, and a speech-capable chat model
  (`openai/gpt-audio`, `text+audio->text+audio`) satisfies both — it is in the
  shipped template for both. What gets rejected is a genuine contradiction: a
  TTS engine in the Transcribe pool emits no text and takes no audio. The
  direct-provider voice slugs (ElevenLabs, Deepgram, Gemini voices) are not in
  the catalog at all and still pass on absence of evidence.

## The repo-shipped template

`packages/client-types/src/model-pools-data.ts` (GENERATED — re-export from a
curated brain via `GET /api/model-pools/export`, don't hand-edit; the one
exception on record is the 2026-09-02 removal of the generator from the
vision pool, noted in the file header) is the
canonical shipped list. Two consumers:

- **Seeding**: `applyManifest` step 7 (`server/web/lib/model-pools-seed.ts`)
  inserts it into `curated_models` for owners with ZERO curated entries —
  fresh installs at onboarding, never-curated brains on the version-bump boot
  reconcile. One existing entry anywhere = the owner's judgment, untouched.
- **Onboarding choices**: `ASSISTANT_MODEL_CHOICES` / `WORKER_MODEL_CHOICES`
  (model-choices.ts) = the hand-written policy head (recommended + azure
  flags, unchanged) extended with the template's `agents` / `summarizer`
  pools, deduped. The API route accepts the wider set immediately; the wider
  cards appear when the jackdaw pin next moves.

## Roadmap context

Phase plan lives on dev-brain task `2ae9fce8`: curator (done) → owner curates →
repo-shipped template export (`GET /api/model-pools/export`) → picker
integration in the Agents Models tab + /settings/ai-workers → named full
combinations.
