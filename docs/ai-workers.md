# AI Workers + Provider Adapter Framework

> The deep dive on how Mantle handles "one-shot AI jobs" (reflector,
> extractor, summarizer, TTS, STT, vision, image-gen) and the adapter
> layer that lets any of them point at any provider. For the bigger
> picture — how this fits with `agents`, the responder, memory, and
> the rest of the stack — start at [architecture.md §9d](./architecture.md#9d-ai-workers--provider-adapter-framework).

## 1. Why this exists

The `agents` table started as a one-table catch-all for "anything that
calls an LLM." Two things became obvious:

1. **Workers don't fit the agent shape.** The reflector, extractor,
   and summarizer don't have personalities, conversation history,
   tool-loops, or turns. They're one-shot transformations triggered
   by system events: a new node arrives → extractor runs; a timer
   fires → reflector runs; chat history hits threshold → summarizer
   runs. Calling them "agents" cluttered the agents table with rows
   that share five fields with real agents and ignore the other ten.

2. **Voice / vision / image-gen don't fit either.** They're
   transformations too, but they don't even call chat models — they
   call dedicated provider APIs (Whisper transcription, TTS speech
   synthesis, vision-LLMs, DALL-E). Adding them to `agents` would
   compound the mismatch.

So the split is:

| Concept | What | UI |
|---|---|---|
| **Agent** | Conversational reasoner with persona, memory, tools, turns | `/settings/agents` |
| **AI worker** | One-shot job: LLM-driven (reflector/extractor/summarizer) OR media transform (TTS/STT/vision/image-gen) | `/settings/ai-workers` |

`agents` keeps the responder + assistant + custom rows. `ai_workers`
gets everything else. The reflector / extractor / summarizer rows
migrated in `0027_ai_workers.sql` with their config preserved.

---

## 2. The data model

```
ai_workers (
  id            uuid PK,
  owner_id      uuid,
  slug          text,         -- 'main-extractor', 'saskia-voice'
  name          text,         -- display label
  kind          ai_worker_kind, -- enum: reflector | extractor | summarizer
                              --       | tts | stt | vision | image_gen
                              --       | embedding
  provider      text,         -- 'openrouter' | 'openai' | 'xai' |
                              -- 'huggingface' | 'anthropic' | 'google' |
                              -- 'elevenlabs' | ...
  model         text,         -- provider-specific model id
  api_key_id    uuid FK,      -- → api_keys.id
  system_prompt text,         -- optional; only used by LLM-driven kinds
  params        jsonb,        -- kind-specific config
  enabled       boolean,
  priority      integer,
  is_default    boolean,      -- partial-unique per (owner, kind)
  last_used_at  timestamptz,
  usage_count   integer,
  created_at    timestamptz,
  updated_at    timestamptz,
  UNIQUE (owner_id, slug)
)
```

**One default per `(owner, kind)`** — enforced by a partial unique
index on `is_default = true`. The runtime calls
`getDefaultWorker(ownerId, kind)` and gets the default (or falls back
to highest-priority enabled row, or null).

**`params` is jsonb** because each kind has its own knobs:

```ts
type TtsParams = {
  voice?: 'nova' | 'alloy' | 'shimmer' | ...    // 13 OpenAI voices
  speed?: number                                  // 0.25–4.0
  format?: 'opus' | 'mp3' | 'wav' | ...
  instructions?: string                           // gpt-4o-mini-tts only
}
type SttParams = { language?: string; max_duration_seconds?: number }
type ReflectorParams = ChatLlmParams & {
  window_size?: number; max_notes_per_run?: number
}
type ExtractorParams = ChatLlmParams & {
  target_types?: string[]; extract_facts?: boolean
  extract_cost_cap_micro_usd?: number
  embedding_model?: string                        // legacy override; see §5e
}
type EmbeddingParams = {
  output_dimensions?: number                      // rare — only honoured by
                                                  // Gemini-embedding-2-preview
}
// ...etc per kind
```

Defined in `packages/db/src/schema/ai-workers.ts` as a discriminated
union. The runtime narrows on `kind` and reads the relevant fields.

---

## 3. The adapter framework

Workers can point at any provider that has a registered adapter for
their capability. The adapter is the only place provider-specific
HTTP shapes and quirks live; everything upstream sees the unified
interface.

### 3.1 Interfaces

Defined in `packages/voice/src/adapters/types.ts`:

```ts
interface ChatDispatcher {
  providerId: ProviderId
  adapterName: string
  chat(opts: ChatOptions): Promise<ChatResult>
  discoverModels?(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>>
  staticCatalog?(): readonly ChatModelInfo[]
}

interface TtsDispatcher {
  providerId: ProviderId
  adapterName: string
  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>
  discoverModels?(apiKey: string): Promise<DiscoveryResult<TtsModelInfo>>
  voicesForModel?(modelId: string, apiKey?: string): Promise<...>
}

interface SttDispatcher { ... transcribe(...) ... }
interface VisionDispatcher { ... extract(...) ... }
interface ImageGenDispatcher { ... generate(...) ... }

interface EmbeddingDispatcher {
  providerId: ProviderId
  adapterName: string
  embed(req: EmbedRequest): Promise<EmbedResult>
  /** Text-only adapters return false for non-text items; callers
   *  surface 'multimodal needs OpenRouter' before the API call. */
  acceptsInput?(input: EmbedInput): boolean
  discoverModels?(apiKey: string): Promise<DiscoveryResult<EmbeddingModelInfo>>
  staticCatalog?(): readonly EmbeddingModelInfo[]
}
```

Each is a stable contract. Callers never construct provider-specific
HTTP requests; they call `adapter.chat(opts)` and let the adapter
handle the translation.

### 3.2 Registry

`packages/voice/src/adapters/registry.ts` — a `Map<ProviderId,
Dispatcher>` per capability. Built-in adapters self-register on
module load:

```ts
// packages/voice/src/adapters/index.ts
registerTtsAdapter(openAiTtsAdapter)
registerTtsAdapter(elevenLabsTtsAdapter)
registerSttAdapter(openAiSttAdapter)
registerChatAdapter(xaiChatAdapter)
registerChatAdapter(huggingfaceChatAdapter)
registerChatAdapter(anthropicChatAdapter)
registerChatAdapter(googleChatAdapter)
registerEmbeddingAdapter(openrouterEmbedding)
registerEmbeddingAdapter(openaiEmbedding)
registerEmbeddingAdapter(googleEmbedding)
registerEmbeddingAdapter(mistralEmbedding)
registerEmbeddingAdapter(cohereEmbedding)
```

The runtime looks up `getChatAdapter(worker.provider)` /
`getTtsAdapter(worker.provider)` / etc. and calls the right interface.

`isProviderWired(providerId, capability)` reports whether an adapter
is registered for that combination — drives the "not yet wired" hint
in the UI dropdown.

### 3.3 Currently shipped adapters

| Provider | Chat | Embedding | TTS | STT | Vision | Image-gen |
|---|---|---|---|---|---|---|
| OpenRouter | ✅ (direct SDK¹) | ✅ openrouter-embedding (only multimodal-capable adapter) | — | — | — | — |
| OpenAI | via OpenRouter¹ | ✅ openai-embedding | ✅ openai-tts | ✅ openai-stt | ✅ openai-vision | ✅ openai-image (gpt-image-1 / DALL-E 3 / DALL-E 2) |
| xAI (Grok) | ✅ xai-chat | — | ✅ xai-tts | ✅ xai-stt | ✅ xai-vision | ✅ xai-image (grok-imagine-image) |
| Hugging Face | ✅ huggingface-chat | — | — | — | — | ✅ huggingface-image (FLUX-1, SDXL, SD 3.5) |
| Anthropic (direct) | ✅ anthropic-chat¹ | — *(provider defers to Voyage AI)* | — | — | ✅ anthropic-vision | — |
| Google (Gemini) | ✅ google-chat | ✅ google-embedding | ✅ google-tts | ✅ google-stt | ✅ google-vision | ✅ google-image (Imagen 3 / 4) |
| Mistral | — | ✅ mistral-embedding | — | — | — | — |
| Cohere | — | ✅ cohere-embedding | — | — | — | — |
| ElevenLabs | — | — | ✅ elevenlabs-tts | ✅ elevenlabs-stt (Scribe v1) | — | — |
| Deepgram | — | — | — | ✅ deepgram-stt | — | — |
| AssemblyAI | — | — | — | ✅ assemblyai-stt | — | — |

¹ **Every chat provider has a registered adapter — including OpenRouter
itself (`openrouter-chat`, since Pre-work B of Phase 3).** The runtime
dispatches via `getChatAdapter(worker.provider).chat({...})` for every
chat-shaped worker (extractor / summarizer / reflector) AND for every
agent's tool loop (responder / assistant / heartbeat fire / invoke_agent).
A worker configured for direct Anthropic actually routes through
`anthropic-chat`'s native /v1/messages endpoint, tool_use blocks and
cache_control markers and all. The previous "OR is the special case
that doesn't go through the registry" asymmetry retired with Phase 3.

Vision providers also power the **Telegram photo ingest** pipeline
(photo → default vision worker → note in `/files`) and Saskia's
`extract_from_image` tool for on-demand OCR.

Image-gen providers power **Saskia's `generate_image` tool** —
generated images land both inline in the chat (Telegram `sendPhoto`
on Telegram, base64 artifact in /assistant) and as a file node under
`/files/generated-images/<yyyy-mm-dd>/`.

### 3.4 The provider catalogue

`packages/voice/src/providers.ts` — closed-set list of every provider
Mantle knows about (12 today). Each entry has `id`, `label`,
`description`, `capabilities[]`, `signupUrl`, `docsUrl`,
`isAggregator?`. Drives:

- `/settings/api-keys` dropdown (which services can a key be for)
- `/settings/ai-workers` provider dropdown (filtered by the worker's
  kind via `providersForCapability(cap)`)
- The signup-link hint shown when a provider is selected

Adding a provider:

1. Add an entry to `SUPPORTED_PROVIDERS`. Provider appears in
   dropdowns immediately (with "not yet wired" hint).
2. Write the catalog file (`catalogs/<provider>.ts`) listing known
   models with capabilities + pricing.
3. Write the adapter (`adapters/<provider>-<capability>.ts`)
   implementing the relevant dispatcher interface.
4. Register it in `adapters/index.ts` (one line).
5. UI lights up automatically — "not yet wired" disappears, model
   dropdown populates, test buttons work.

---

## 4. Discovery — finding which models your key can use

Static catalogs say "here are the models this provider has published."
But your specific key might not have access to all of them (free
tier, regional restrictions, beta gates). Live discovery hits the
provider's models endpoint and intersects:

```
catalog (static)         /v1/models (live, per key)
       ▲                          ▲
       └────────── ∩ ─────────────┘
                   │
                   ▼
       what your key can actually call
```

Implemented per-adapter via the optional `discoverModels(apiKey)`
method. Soft-fails to the static catalog if the call errors (with a
"couldn't verify" hint in the UI). Each provider's discovery shape:

| Provider | Endpoint | Notes |
|---|---|---|
| OpenAI | `GET /v1/models` | Flat list of `{id, owned_by}`; filter by name prefix |
| xAI | `GET /v1/models` (assumed) | OpenAI-compat; falls back if not present |
| Hugging Face | `GET /v1/models` | Returns hundreds; we curate via catalog filter |
| Anthropic | `GET /v1/models` | Returns dated + alias ids; we match against both |
| Google | `GET /v1beta/models` | Filter to `supportedGenerationMethods: ['generateContent']` |
| ElevenLabs | `GET /v1/models` | Plus `GET /v1/voices` for the cloned-voice picker |

The UI re-runs discovery when the API key OR the provider changes.
Manual refresh button on the model dropdown for "I added a new model
in the provider console, pick it up now."

---

## 5. Voice in/out — end-to-end

The voice-modality pipeline is the most worked-out example of how
`ai_workers` + adapters compose with the responder. Inbound and
outbound both route through workers:

### 5.1 Inbound

```
1. User sends Telegram voice note
2. apps/web/workers/telegram-poll.ts ingests via Telegram getUpdates
3. INSERT telegram_messages row with text='(voice message)' and
   attachments=[{kind: 'voice', file_id: '...'}]
4. pg_notify('telegram_message_inserted') fires
5. apps/agent/src/main.ts handleMessage receives it:
   a. Atomic claim (processed=true) prevents duplicate replies
   b. Detect voice attachment
   c. Open trace, open transcribe_voice step
   d. Look up default STT worker via getDefaultWorker(ownerId, 'stt')
   e. Resolve adapter via getSttAdapter(worker.provider)
   f. downloadTelegramFile(account, fileId) → bytes
   g. adapter.transcribe(bytes, {apiKey, model, language, maxDuration})
   h. UPDATE telegram_messages SET text = transcript
   i. Continue normal responder flow — load_context, runToolLoop,
      generate reply text
```

### 5.2 Outbound

```
6. Responder produces reply text. Two ways voice-out fires:
   - wasVoice = true (user voice-messaged us, mirror the modality)
   - LLM emitted [VOICE] marker at start of reply (explicit opt-in)
7. If replyAsVoice:
   a. Strip [VOICE] marker from reply
   b. Look up default TTS worker via getDefaultWorker(ownerId, 'tts')
   c. Resolve adapter via getTtsAdapter(worker.provider)
   d. adapter.synthesize({apiKey, text, voice, speed, instructions, format})
      Format defaults to 'opus' (Telegram-native voice notes)
   e. sendVoice(account, chatId, audioBytes)
   f. bumpAiWorkerUsage(worker.id)
   g. Failure → fall through to sendMessage with text reply
8. Else sendMessage with text reply (existing path).
```

Configuration lives entirely in the TTS / STT worker rows. Changing
Saskia's voice from Nova to a cloned ElevenLabs voice is:

1. Add an ElevenLabs key at `/settings/api-keys`.
2. Edit the TTS worker at `/settings/ai-workers`:
   - Provider: ElevenLabs
   - Model: eleven_v3 (or whichever)
   - Voice: pick from the live-fetched list (includes your clones)
   - Save and mark as default
3. Next voice message uses the new voice. No code change, no restart.

The `[VOICE]` opt-in marker is documented in Saskia's system prompt
template — see [memory.md §6.2](./memory.md#62-the-agent-roles) for
where that lives.

### 5a. Speech tags — inline + wrapping

Voice models expose two tag vocabularies, and the framework treats both
uniformly (see `packages/voice/src/adapters/types.ts` — `AudioTag` and
`WrappingTag`):

- **Inline tags** — point-in-time cues in square brackets: `[laughs]`,
  `[sigh]`, `[pause]`. Advertised per-model via
  `TtsDispatcher.supportedAudioTags(model)`.
- **Wrapping tags** — angle-bracket pairs that style a whole phrase:
  `<whisper>it's a secret</whisper>`, `<soft>…</soft>`, `<slow>…</slow>`.
  Advertised via `TtsDispatcher.supportedWrappingTags(model)`. **xAI
  Grok voice** is the provider that ships these today (volume / pitch /
  pacing / style). ElevenLabs and Google were audited and express
  everything through inline tags + natural-language steering, so they
  return `[]`.

Both flow the same way each turn:

1. The runtime asks the active TTS adapter for both sets and folds them
   into Saskia's system prompt via `composeAudioTagInstructions(inline,
   wrapping)` — one combined paragraph, grouped by category, so she only
   emits tags this model will render.
2. On voice-out, the tags ride through to the synthesizer untouched.
3. On text-out (or TTS fallback), `stripAudioTags` removes inline tags
   entirely and removes wrapping **markers while keeping the inner
   text** (`<whisper>x</whisper>` → `x`). Wrapping stripping matches an
   explicit speech-name allowlist, so autolinks (`<https://…>`) and
   real HTML are left alone.

Operators see both lists under the voice dropdown at
`/settings/ai-workers/<id>` (collapsible "Inline audio tags" /
"Wrapping speech tags" sections).

---

## 5b. Attachment ingestion (images + documents)

> Full reference (flow table from every source + production audit):
> [`file-ingestion.md`](./file-ingestion.md). This section is the vision/worker
> view.

Every file that enters Mantle — uploaded via the Files UI, attached to a
`/assistant` turn, sent to the Telegram bot, dropped on disk, or pushed
through MCP — is handled by **two cleanly-separated responsibilities**:

1. **Durable indexing (universal, async).** Save bytes → `node_ingested` →
   the **extractor** is the *single* producer of durable metadata
   (`data.text` + summary + embedding + facts), type-dispatched: images →
   neutral vision (describe+OCR), pdf/docx/xlsx → `parseDocumentBytes`, text →
   `data.content`. This runs for every file regardless of how it arrived.
2. **Live answer (conversational surfaces only, sync, ephemeral).** The web
   `/assistant` and Telegram run a **question-aware** read of the attachment
   for the immediate reply — never persisted. Both call the one shared helper.

### The shared primitives (no duplication)

- `parseDocumentBytes(bytes, ext)` — `@mantle/files`. The one place that maps
  format → parser. Used by the extractor and the live-answer helper.
- `runVisionWorker({ ownerId, bytes, mimeType, filename, prompt? })` —
  `@mantle/agent-runtime`. Resolves the owner's default vision worker,
  transcodes HEIC, runs the adapter. Best-effort: returns `ran:false` + a note
  rather than throwing. Used by the extractor (neutral) and the live-answer
  helper (question-aware).
- `extractAttachmentForTurn({ ownerId, bytes, mimeType, filename, question? })`
  — `@mantle/agent-runtime`. The conversational helper: image → vision, doc →
  `parseDocumentBytes` (capped at `DOC_TEXT_MAX` 24K), returns
  `{ kind, text, note }`. Used by both `/assistant` and Telegram.
- `buildAttachmentContextText(text, { kind, transcript, note, nodeId })` —
  folds the extracted text into the turn with the file node id surfaced so
  Saskia can re-read the original (`extract_from_image` for images,
  `file_read` for documents).

### Per-surface flow

- **Web `/assistant`** (`processUpload`): save to
  `/files/assistant-uploads/<date>/` → `extractAttachmentForTurn` → fold into
  the turn. Images also echo an inbound artifact so the bubble renders them;
  documents render a client-side file chip. Accepts images + documents
  (pdf/docx/xlsx/csv/txt/md/json/yaml); anything else → 415.
- **Telegram** (`handleMessage`): a `photo` OR `document` attachment →
  `downloadTelegramFile` → save to `/files/telegram-uploads/<date>/` →
  `extractAttachmentForTurn` → fall through to the responder. **Full parity
  with the web** — documents are no longer dropped. (`voice` still routes
  through STT; `audio`/`video` are not yet handled.)
- **Files UI / disk-watcher / MCP**: save only — no inline pass. The extractor
  picks them up and produces the durable index (images via `runVisionWorker`,
  docs via `parseDocumentBytes`).

**Transcript-default + reliability.** The responder prefers the extracted
text; for an *image* with no transcript it falls back to inlining the raw
pixels only when the model is vision-capable and the image is within the
provider's per-image limit (`maxImageBytesFor` — guards Bedrock's opaque
"Could not process image" on oversized photos). On any responder error with an
image attached, the web turn retries once text-only. Extraction failures fall
back to a `[… couldn't be read: <reason>]` marker. A misconfigured/missing
vision worker leaves an image findable by filename and records the reason on
the `photo_ingest` trace — the system stays up; enrichment is best-effort.

**HEIC/HEIF (iPhone default).** Vision providers can't read HEIC, so
`runVisionWorker` runs `transcodeImageForVision` (`@mantle/files`) first —
HEIC/HEIF → JPEG via `heic-convert` (libheif WASM, no native dep), passthrough
otherwise. Lazy-imported; on a decode failure it returns the original bytes and
degrades as before. `heic-convert` is in `serverExternalPackages` so Next
leaves its `.wasm` alone.

---

## 5c. Image generation — out

Saskia generates images via the `generate_image` builtin tool. The
tool resolves the default image_gen worker, calls the adapter, and:

- Saves the bytes to `/files/generated-images/<yyyy-mm-dd>/<unix-ms>-<slug>.<ext>`
  (auto-creates the folders, idempotent on race).
- On Telegram surface: `sendPhoto` with the prompt as caption.
- On /assistant surface: emits an image artifact the chat page renders
  inline in the reply bubble.
- Returns to the LLM: `{nodeId, storagePath, model, adapter, mimeType,
  bytes, revisedPrompt?}` — enough metadata for Saskia to mention what
  she sent.

DALL-E 3 surfaces a `revised_prompt` field when the model rewrites
the prompt for safety/quality; this rides through as
`artifact.caption` so the operator sees what the model actually
rendered against.

---

## 5d. Tool-delegation surface — Saskia can call workers explicitly

Workers have **four invocation paths**, deliberately:

1. **Automatic pipeline** — modality-matched (voice-in → voice-out,
   photo → vision ingest, node-save → extractor).
2. **Tool-mediated** — Saskia chooses to invoke a worker mid-turn via
   one of these builtins:
     - `synthesize_speech(text)` — TTS for explicit "send me a voice
       note" requests. Telegram → `sendVoice`; web → audio artifact
       rendered as `<audio controls>` in the reply.
     - `extract_from_image(node_id | telegram_file_id, prompt?)` —
       run vision on a previously-uploaded image or a Telegram file
       reference.
     - `summarize_text(text | node_id, focus?, max_words?)` — run the
       default summarizer worker over inline text or a note body.
     - `generate_image(prompt, size?, style?, quality?, negative_prompt?)`
       — image generation as documented above.
3. **UI test buttons** — `/settings/ai-workers/<id>` has per-kind
   test surfaces (record mic, pick image, type prompt) so operators
   can verify config without invoking Saskia.
4. **Heartbeat-driven** — a [heartbeat](./heartbeats.md) fires on
   schedule and runs the agent's normal tool loop. The agent then
   freely calls any of the above tools (TTS, image-gen, summarizer)
   from inside the synthetic-prompt fire. The 5 extra
   `heartbeat_*` control tools (complete / snooze / update_state /
   list / fire) live alongside, available only inside a heartbeat
   context (enforced via AsyncLocalStorage).

Each tool returns structured `{ok: false, error}` when its worker
isn't configured, so the LLM tells the user "I'd love to but the
default vision worker isn't set up" rather than silently failing.

The mental model: **workers are services; tools are agent-callable
interfaces to those services; pipelines + heartbeats are
event-driven invocations of those same services.** All four paths
can run for the same worker without conflicting.

---

## 5e. Embedding — the cross-cutting kind

Added in migration `0047_ai_worker_kind_embedding.sql`. Unlike the
other worker kinds (which are each triggered by one signal — `tts` by
voice replies, `extractor` by `pg_notify('node_ingested')`, etc.),
**embedding is read by every memory layer in the stack**:

1. **Extractor write path** — every `node_ingested` produces a vector
   on `nodes.embedding`, `entities.embedding`, `facts.embedding`.
2. **Responder + assistant** — embed the inbound message to retrieve
   semantic memory.
3. **`recall_window` builtin (Remy)** — embeds the query for
   time-windowed semantic search.
4. **MCP `search_chunks`** — Claude Desktop's tool call.
5. **Tool-result spill store `read_result query`** — embeds the query
   against the spilled artifact's chunks (`tool_result_chunks`).
6. **Assistant per-turn retrieval** — same embed-and-search pattern as
   the responder.

Before this kind existed, the model was either env-implicit
(`MANTLE_EMBEDDING_MODEL` or the hardcoded fallback) or set as a
per-worker override on the extractor only. The override field covered
just one of those six call sites — a misleading "this is THE knob"
shape — so embedding got promoted to a first-class kind.

### 5e.1 Resolution chain

```
Any code calling embed() / embedBatch()
   │
   ├─ explicit opts (model / provider / apiKeyId)?  ── yes ──→ use it (per-call override)
   │
   └─ no? ── resolveEmbeddingConfig(ownerId)
                 │
                 ├─ ai_workers row, kind=embedding, enabled, is_default ── yes ──→ use its (model, provider, apiKeyId)
                 │
                 └─ no? ──→ { model: env var || hardcoded fallback,
                             provider: 'openrouter',
                             apiKeyId: null }
```

Lives in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts).
The resolver returns the FULL config (model + provider + apiKeyId), not
just the model slug — because dispatch needs all three to talk to the
right adapter with the right key. A backward-compat `resolveEmbeddingModel`
remains as a thin wrapper for the few callers that only need the model
(the reembed script's logging line).

The resolver caches per-ownerId in-process for 60s — necessary because
the extractor batches embed many texts per ingest, and recall + spill
embed per query. The cache is dropped on `clearEmbeddingModelCache(ownerId)`
which the workers form mutations call after every save / setDefault /
delete that touches an embedding worker. So a model swap kicks in on
the next ingest / recall, not after a TTL.

### 5e.2 Adapter dispatch (Stage 1 of the runtime-honesty push)

`@mantle/embeddings#embed()` was originally hardcoded to OpenRouter's
endpoint with `getApiKey(ownerId, 'openrouter')` — even though the
worker schema carried `provider` and `apiKeyId` fields. **The Stage 1
work landed in [`5dc3984`](https://github.com/TitanKing/mantle/commit/5dc3984)
makes embedding genuinely multi-provider**: the runtime dispatches
through the same adapter registry the TTS/STT/vision/image-gen kinds
use, and the form unlocks the provider dropdown to match.

Five embedding adapters in [`packages/voice/src/adapters/`](../packages/voice/src/adapters/):

| Adapter | Endpoint | Multimodal | Discovery |
|---|---|---|---|
| `openrouter-embedding` | `/api/v1/embeddings` | ✅ (gemini-embedding-2-preview, nemotron-embed-vl) | keyless via `/api/v1/embeddings/models` |
| `openai-embedding` | `/v1/embeddings` | text-only | filtered `/v1/models` |
| `google-embedding` | `:batchEmbedContents` (model in URL path, key as query string) | text-only | filtered `/v1beta/models` by `embedContent` capability |
| `mistral-embedding` | `/v1/embeddings` (OpenAI-compatible) | text-only | filtered `/v1/models` |
| `cohere-embedding` | `/v2/embed` (own shape: `texts`, `input_type`, `embedding_types`) | text-only | filtered `/v1/models` |

Each adapter implements:
- `embed(req)` — translates the unified `EmbedRequest` to the provider's
  native shape, parses the response back to `EmbedResult`.
- `acceptsInput(item)` — text-only adapters return `false` on
  multimodal items so the caller surfaces a clear "use OpenRouter for
  multimodal" error rather than letting the upstream API reject it.
- `discoverModels(apiKey)` — per-provider catalog fetch, falls back to
  `staticCatalog()` if the API call fails.

The runtime path in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts):

```
embed(ownerId, text) → embedBatch → embedMultimodal
   │
   ├─ resolveEmbeddingConfig(ownerId)       — DB lookup, 60s cached
   ├─ getEmbeddingAdapter(config.provider)  — registry lookup
   ├─ adapter.acceptsInput per input        — text/multimodal guard
   ├─ embedding_cache lookup by (model, content_hash)
   ├─ for misses: apiKey via getApiKeyById(apiKeyId) or
   │     getApiKey(ownerId, provider) fallback
   └─ adapter.embed({apiKey, model, input, dimensions: 1536})
```

The cache stays keyed on `(model, content_hash)` so two providers
serving the same slug share entries. Different slugs (OR's
`openai/text-embedding-3-small` vs OpenAI direct's
`text-embedding-3-small`) cache separately — they produce identical
vectors but a cache miss on first use after a provider swap is acceptable.

### 5e.3 Discovery — per-provider

OpenRouter splits its catalog: chat + image at `/api/v1/models`,
**embeddings at `/api/v1/embeddings/models`** (the main catalog
intentionally excludes embedding routes). Both endpoints are keyless.

Direct providers each have their own discovery quirks the adapter
encapsulates:
- **OpenAI**: `/v1/models` returns everything (chat + embeddings +
  audio + image); the adapter filters by id pattern `/embedding/i`.
- **Google**: `/v1beta/models` returns everything; filter by
  `supportedGenerationMethods` containing `embedContent`.
- **Mistral**: `/v1/models` is small enough that an id pattern filter
  matches reliably (`/embed/i`).
- **Cohere**: `/v1/models` includes an `endpoints` array per model;
  filter by `endpoints.includes('embed')`.

The `/models` page's OpenRouter view fetches both
`/v1/models` and `/v1/embeddings/models` in parallel via
`Promise.allSettled` (so a flake on one doesn't blank the page) and
concatenates — [`apps/web/lib/model-explorer.ts`](../apps/web/lib/model-explorer.ts).

Heuristic gotcha worth knowing: 13 of OR's 25 embedding models lack
`embed` in their slug (sentence-transformers, GTE, E5, BGE, MiniLM,
MPNet, paraphrase families). The /models fetcher overrides
`kind: 'embedding'` on the embeddings-endpoint branch unconditionally
— the URL is the source of truth, not the slug pattern.

### 5e.4 Two cliffs, both handled in the form

A model swap can fail in two distinct ways. The form surfaces both:

**(a) Dimension mismatch — column rejects the insert.** The brain has
`vector(1536)` columns (`nodes.embedding`, `entities.embedding`,
`facts.embedding`, `content_chunks.embedding`). Switching to a model
that emits anything other than 1536 dims (e.g. `text-embedding-3-large`
at 3072) would crash ingest on its first call.

The form has a **"Test dimensions" button** that embeds the string
`'dimension probe'` with the picked model and reads back the actual
vector length. The result populates a per-slug detected-dim cache and
also drives a hand-curated `KNOWN_DIMS` allow-list (12 verified slugs)
as a fallback. When dim is **known and ≠ 1536**, the Save button is
hard-blocked with a destructive-banner explanation — switching to a
non-1536 model needs a schema migration on every vector column, which
isn't a button.

**(b) Vector-space drift — column accepts, retrieval silently breaks.**
Two embedding models with the same dim (both 1536) produce vectors in
*completely different coordinate systems*. Cosine similarity across
spaces is meaningless: existing vectors embedded with model A return
random matches for queries embedded with model B. The column accepts
the inserts; the brain just stops working semantically.

The form has a **"Rebuild Index" button** (edit mode only, gated on
`!modelDirty` so the save commits first) that wraps
[`runReembed(ownerId, opts)`](../packages/embeddings/src/reembed.ts).
The helper walks `nodes`, `entities`, `facts`; re-embeds every row
against the current resolver value; idempotent under the
`embedding_cache` so re-running against the same model is free. Per-owner
in-flight Map prevents double-click / multi-tab waste — the cache key
includes `(ownerId, model, dryRun)`.

The CLI `pnpm re-embed` shares the same code path. The script became a
thin wrapper around `runReembed`; the UI button does the same thing
without leaving the browser.

### 5e.5 The legacy override field

`ExtractorParams.embedding_model` predates this kind. Now relabelled
"Embedding model override (advanced)" with a pointer at the canonical
worker. Kept functional for niche cases (cache preservation during a
migration, historical reproduction) but discouraged — mismatched
embedders across consumers produce silent retrieval degradation, which
is a bigger UX failure than a missing per-worker knob. Same applies to
`agents.memory_config.embedding_model` (responder / assistant per-turn
retrieval override).

The intended path: set the embedding AI worker, leave every override
blank. The resolver picks it up everywhere.

---

## 6. Testing affordances

Each worker kind has a test button in `/settings/ai-workers/<id>`:

- **TTS:** synthesises a sample with the saved config, plays inline
  via `<audio>`. Confirms voice + speed + key wiring without sending
  a Telegram message.
- **STT:** records from the browser mic via MediaRecorder, sends to
  the adapter, shows transcript + detected language + duration.
- **Vision:** pick an image from disk; runs through the worker's
  vision adapter and shows the extracted text, the model that ran it,
  token counts, and the model's revised prompt (when applicable).
  Doesn't persist — for iterating on the per-image prompt before
  pointing the ingest pipeline at it.
- **Image-gen:** type a prompt; renders the generated image inline
  with model + adapter info. Also doesn't persist; the production
  `generate_image` tool is the one that saves to Files.
- **Chat (reflector/extractor/summarizer with non-OpenRouter
  provider):** sends a one-shot prompt through the worker's adapter,
  shows reply + model that served it + token counts. Useful for
  verifying that a new Anthropic / Grok / HF key actually works
  before relying on the worker.

All test buttons route through the same adapter the runtime uses, so
a successful test means production will also work.

`/settings/api-keys` also has a per-key **Test** button that runs the
adapter's `discoverModels` as an auth probe — instant green/red on
whether the key is alive without needing to also configure a worker.

---

## 7. What's NOT in the adapter registry (and why)

Post-Phase 3 (May 2026), the answer is: **almost nothing.** Every
capability dispatches through the adapter registry, including the
production responder / web `/assistant` / heartbeat / extractor /
summarizer / reflector chat paths.

A short list of intentional escapes worth knowing:

- **`builtins-research.ts` (Perplexity search via OpenRouter).** The
  research tool handler still constructs `new OpenRouter()` directly
  because it's calling Perplexity's `online` route as a tool, not as a
  chat-shaped worker. The OR SDK's response shape carries the per-search
  surcharge on `usage.cost`, which `captureLlmUsage` (the raw-response
  helper) reads natively. Migrating this to the chat adapter would gain
  nothing — there's no "switch Perplexity to a different provider" story.

- **The OpenAI carve-out in `isProviderWired('openai', 'chat')`.** Returns
  true even though no `openai-chat` adapter exists. OpenAI chat is
  reached via OpenRouter today and probably forever (OR's OpenAI route
  is identical pricing + adds failover). If a user genuinely wants
  direct OpenAI chat we'd add the adapter file; nothing else needs to
  change.

Phase 3 stage history (kept for archaeology):
- **Stage 1** (`5dc3984`): embedding migration. `@mantle/embeddings`
  routes via `getEmbeddingAdapter(provider)`.
- **Stage 2** (`b7d57e9`): form clamps. Make the UI HONEST about
  Phase-3-pending chat routing.
- **Phase 3 Pre-work A** (`97298a5`): widen ChatResult with
  cacheReadTokens / cacheWriteTokens / reportedCostUsd.
- **Phase 3 Pre-work B** (`6297e66`): openrouter-chat adapter.
  Closes the framework asymmetry.
- **Phase 3 Pre-work C** (`4f95681`): recordChatUsage helper for
  the typed ChatResult shape.
- **Phase 3a** (`652ba19`): chat-shaped workers migrated.
- **Phase 3b** (`148d423`): tool loop refactored — adapter dispatch
  + normalised tool calls across Anthropic / Google / OpenAI shapes.
- **Phase 3c** (`3581f61`): `agents.provider` column (migration 0048).
- **Phase 3d** (`38e2cbc`): forms unclamped. Operators can now
  configure responder + workers for direct Anthropic / Google /
  xAI / HF.

Vision and image-gen adapters have been live since May 2026 — see §3.3
for the matrix. Vision plugs into both Telegram photo ingest (automatic)
and Saskia's `extract_from_image` tool (on-demand). Image-gen plugs into
Saskia's `generate_image` tool. Both are wired for OpenAI, xAI, Google,
and (image-gen only) Hugging Face. Anthropic ships vision but no image
generation.

---

## 8. The configuration surface (operator view)

What an operator needs to do to make every capability work:

1. **At `/settings/api-keys`**, add keys for the providers you want:
   - OpenRouter (required — covers chat for the responder, extractor,
     summarizer, reflector by default)
   - OpenAI (required if you want voice in/out, since the default STT
     and TTS workers point here)
   - Anthropic / Google / xAI / Hugging Face / ElevenLabs as desired

2. **At `/settings/agents`**, configure the conversational agent:
   - Responder (Telegram) — the persona the user actually talks to.
     Sets persona, memory depth, system prompt, tool allowlist,
     skills. Points at an OpenRouter key + model by default.
   - Optionally a separate Assistant (web `/assistant`). Falls back
     to responder if not set.

3. **At `/settings/ai-workers`**, configure the one-shot workers:
   - **Reflector** — appends to responder's persona_notes from
     recent dialog. Backfilled from `agents` if you had one.
   - **Extractor** — runs on every `node_ingested`. Backfilled.
   - **Summarizer** — rolls Telegram conversation history into digest
     nodes. Backfilled.
   - **TTS** — required for voice replies on Telegram. Default:
     OpenAI gpt-4o-mini-tts with voice=nova.
   - **STT** — required for voice-message transcription. Default:
     OpenAI whisper-1.
   - **Embedding** — optional but recommended. Without one, the
     resolver falls through env → hardcoded
     `openai/text-embedding-3-small`. Creating the worker makes the
     model an explicit DB choice instead of an env-implicit fallback,
     and unlocks the form's Test / Rebuild affordances. See §5e.
   - Vision / image-gen — config saved but dispatch not yet wired.

Each worker has its own model, API key, params. Multiple workers per
kind are allowed (priority + is_default flag picks the winner).

### 8.1 Provider routing today — what goes through what

Every kind dispatches the same way: through the adapter registry, with
the worker's (or agent's) `provider` field driving which adapter
resolves. Phase 3 (commits 97298a5 through 38e2cbc) unified the model.

| Kind | Runtime path | `provider` field | `apiKeyId` field | API key dropdown filter |
|---|---|---|---|---|
| **TTS / STT / Vision / Image-gen** | Adapter registry — `getXxxAdapter(worker.provider)` | ✅ honoured — picks the adapter | ✅ honoured | filtered to keys whose service ∈ providers declaring this capability |
| **Embedding** | Adapter registry — `getEmbeddingAdapter(worker.provider)` (Stage 1, §5e.2) | ✅ honoured — picks the adapter | ✅ honoured | filtered to keys whose service ∈ {openrouter, openai, google, mistral, cohere} |
| **Reflector / Extractor / Summarizer** | Adapter registry — `getChatAdapter(worker.provider).chat({...})` (Phase 3a) | ✅ honoured — picks the adapter | ✅ honoured | filtered to keys whose service matches the selected provider |
| **Agents** (responder / assistant / custom / heartbeat / invoke_agent) | Adapter registry — `getChatAdapter(agent.provider).chat({...})` via `runToolLoop` (Phase 3b) | ✅ honoured — `agents.provider` column added in migration 0048 | ✅ honoured | filtered to keys whose service matches the selected provider |

**What this enables, concretely:**
- An extractor pointed at `provider='anthropic'` + `model='claude-haiku-4-5'`
  routes through Anthropic's /v1/messages endpoint; cache_read tokens
  surface in `/traces`.
- The responder configured for `provider='google'` + `model='gemini-2.5-pro'`
  emits `functionCall` parts for tool use, gets `cachedContentTokenCount`
  from Gemini's implicit caching on /traces.
- OpenRouter is no longer the special case — `openrouter-chat` is just
  another adapter (with the OR SDK as its HTTP layer + cache markers
  flowing through via the SDK's typed `cacheControl` field).

---

## 9. Implementation map

If you're reading the code, the canonical files to start with are:

1. `packages/db/src/schema/ai-workers.ts` — schema + param types
2. `packages/db/src/ai-workers-resolve.ts` — `getDefaultWorker`,
   `bumpWorkerUsage` (shared between apps/web and apps/agent)
3. `packages/voice/src/providers.ts` — provider catalogue
4. `packages/voice/src/adapters/types.ts` — dispatcher interfaces
5. `packages/voice/src/adapters/registry.ts` — registry + lookups
6. `packages/voice/src/adapters/openai-tts.ts` — reference adapter
7. `packages/voice/src/adapters/anthropic-chat.ts` — adapter with
   non-trivial translation (system field, max_tokens required)
8. `packages/voice/src/adapters/elevenlabs-tts.ts` — adapter with
   live voice discovery
9. `apps/web/app/(app)/settings/ai-workers/worker-form.tsx` — UI
   that ties it all together; reactive provider/model/voice dropdowns
10. `apps/agent/src/main.ts` (search for `getSttAdapter` /
    `getTtsAdapter`) — runtime integration for voice in/out
11. `packages/embeddings/src/index.ts` — `resolveEmbeddingModel`,
    `embed`, `embedBatch`, `clearEmbeddingModelCache`. The resolver
    chain + per-ownerId cache.
12. `packages/embeddings/src/reembed.ts` — `runReembed`, used by both
    the CLI script (`pnpm re-embed`) and the workers form's
    Rebuild Index button.

---

## 10. Future shape

### 10.1 Phase 3 — Direct-provider routing for chat-shaped workers + agents

**Status: SHIPPED (May 2026). The work is preserved here for archaeology;
§7 has the final stage list with commit shas.**

**What's outstanding.** The chat-shaped workers (reflector / extractor /
summarizer) and all agents (responder / assistant / custom) still
construct `new OpenRouter({apiKey})` directly instead of going through
the chat adapter registry. The forms reflect this honestly today —
clamped to `service='openrouter'` keys with explanatory copy — but
that's the *less ambitious* end-state. The bigger move is to migrate
the runtime so the `provider` field actually controls dispatch, the
same way TTS / STT / Vision / Image-gen / Embedding already do.

**Why it was deferred.** For a single-user OpenRouter-only install
(today's typical Mantle operator), the cost-benefit is poor:
OpenRouter's chat margin is in the low single digits, the engineering
effort is ~800-1000 LOC, and the user-facing experience already works.
Stage 2 of the runtime-honesty push made the forms honest about the
status quo so an open-source contributor doesn't get confused — that's
the immediate UX win. Phase 3 is the structural move that follows when
either (a) operators ask for direct-Anthropic / direct-OpenAI routing
for cost reasons, (b) a multi-provider failover story becomes useful,
or (c) someone wants to wire Voyage AI for embeddings as a non-OR
embedding provider.

#### Concrete work for Phase 3

Five sub-pieces, mergeable in order. Each is independently shippable.

**3a. Migrate `apps/agent/src/extractor.ts` to the chat adapter registry**
(~50 LOC). The simplest piece. Replace `new OpenRouter({apiKey})` with
`getChatAdapter(worker.provider).chat({...})`. The chat dispatchers
already exist (xai-chat, huggingface-chat, anthropic-chat, google-chat
in `packages/voice/src/adapters/`), they just aren't called from
production. The extractor's chat call is a single turn — no tool
loop — so the call-site change is mechanical. Same for
[`apps/agent/src/summarizer.ts`](../apps/agent/src/summarizer.ts) and
[`apps/agent/src/reflector.ts`](../apps/agent/src/reflector.ts) — same
shape, same fix.

**3b. Tool loop refactor** (~400-500 LOC, the hard piece).
[`packages/agent-runtime/src/tool-loop.ts`](../packages/agent-runtime/src/tool-loop.ts)
currently calls `client.chat.send()` on the OpenRouter SDK — tightly
coupled to OR's response shape. Migrating means:
- The chat adapters need to expose tool-call info on `ChatResult`
  (today their `chat()` returns just `{text, model, tokensIn, tokensOut}`).
- Each provider serialises tool calls differently:
  Anthropic emits `tool_use` blocks inside `content[]`, OpenAI emits
  a `tool_calls` array on the message, Google emits `functionCall`
  on `parts[]`. Each adapter has to normalise to a single shape that
  `runToolLoop` can iterate.
- Streaming was previously deferred (see [the streaming feasibility
  conversation](https://github.com/TitanKing/mantle/commits/main) —
  search for "Assistant streaming"); not in scope for Phase 3 either.
  Keep one-shot calls for now.

**3c. Add `provider` column to `agents` table** (~100 LOC). New migration
(`0048_agents_provider.sql`), Drizzle schema update, agents-client.tsx
gets a provider dropdown. Same `RUNTIME_OR_ONLY_KINDS`-equivalent
mechanism the workers form uses — except inverted: now that the
runtime supports direct providers, the form unlocks the dropdown.

**3d. Unclamp the workers + agents forms** (~50 LOC). Remove the
`RUNTIME_OR_ONLY_KINDS` set in
[`apps/web/app/(app)/settings/ai-workers/worker-form.tsx`](../apps/web/app/(app)/settings/ai-workers/worker-form.tsx).
Remove the `service === 'openrouter'` filter in
[`apps/web/app/(app)/settings/agents/agents-client.tsx`](../apps/web/app/(app)/settings/agents/agents-client.tsx).
The KeyValidityHint and capability filters take over from there —
they already work for the other kinds.

**3e. Docs cleanup** (~30 LOC). Update §8.1 routing table to flip
chat-shaped + agents to "adapter registry, provider honoured". Remove
the "Stage 2 clamps" notes from §5e and the worker form. Update
[`docs/architecture.md`](./architecture.md) §16 (known sharp edges)
to retire the "production chat still routes through OpenRouter SDK
directly" entry.

#### Order of execution

Recommended sequence (each commit-sized, independently mergeable):

1. **3a first** — easiest, validates the chat adapter framework end-to-end
   against real production traffic without touching the tool loop.
   Single-turn chat is the unit test of the adapter; if Anthropic-direct
   works for the extractor, it'll work everywhere.
2. **3b next** — the tool loop refactor. Most of the engineering risk
   is here.
3. **3c then 3d together** — schema change + form unlock. Trivial after
   the runtime supports it.
4. **3e last** — docs cleanup once the migration is durable.

#### Risk surfaces a fresh session should look at carefully

- **Cache key sensitivity in tool-loop steps.** Anthropic's prompt
  caching (the `cache_control: { type: 'ephemeral' }` markers on the
  system block + digest block) is emitted by the OpenRouter SDK
  call. The chat adapters need to honour it too — `ChatOptions` should
  grow a `cacheControl?` option or the adapters should detect it from
  message metadata. Worth tracing through carefully because cache hits
  are the dominant cost-saving on the responder path.
- **Tool-call reassembly.** Streaming is out of scope (per the
  deferred streaming discussion), so this is simpler than it could
  be — but each provider's response format still differs. Anthropic's
  `tool_use` blocks have `input` as a parsed object; OpenAI's
  `tool_calls[].function.arguments` is a JSON string. The adapter
  layer has to normalise.
- **Usage capture.** `captureLlmUsage` reads `result.usage` to bill
  token counts to the trace. Every chat adapter needs to populate
  `ChatResult.tokensIn` / `tokensOut` consistently — the existing
  OpenRouter SDK path is the reference shape.
- **Trace prompt-cache breakpoints.** When migrating, verify
  `read_result` / tool-result spill still triggers the right break-
  points for re-sent context. That's covered by integration testing
  on the responder path post-3b.

### 10.2 Other open items

- **Vision adapter for whiteboard ingestion.** Image attachments
  arrive → vision adapter extracts markdown → ingested as a note.
  OpenAI / Anthropic / Google all do this; pick one as the first
  built-in flow.
- **Image-gen tool for the responder.** Tool wrapper on top of an
  image-gen adapter so Saskia can generate diagrams / illustrations
  when asked.
- **Voyage AI as an embedding provider.** Now that the embedding
  adapter framework is in (§5e.2), adding Voyage is just another
  adapter file + a `SUPPORTED_PROVIDERS` entry. Worth doing if/when
  Anthropic users ask for "the official Anthropic-recommended
  embedding path."
- **Provider-aware cost tracking.** Each adapter knows the price of
  the call it made; surfacing per-provider spend in `/debug` would
  make cost-conscious provider choice obvious. Easy add post-Phase 3
  once all paths go through adapters.
