# AI Workers + Provider Adapter Framework

> The deep dive on how Mantle handles "one-shot AI jobs" (reflector,
> extractor, summarizer, TTS, STT, vision, image-gen) and the adapter
> layer that lets any of them point at any provider. For the bigger
> picture, how this fits with `agents`, the responder, memory, and
> the rest of the stack, start at [architecture.md §9d](./architecture.md#9d-ai-workers--provider-adapter-framework).

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
   transformations too, but they don't even call chat models; they
   call dedicated provider APIs (Whisper transcription, TTS speech
   synthesis, vision-LLMs, DALL-E). Adding them to `agents` would
   compound the mismatch.

So the split is:

| Concept       | What                                                                                                    | UI                     |
| ------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Agent**     | Conversational reasoner with persona, memory, tools, turns                                              | `/settings/agents`     |
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

**One default per `(owner, kind)`**: enforced by a partial unique
index on `is_default = true`. The runtime calls
`getDefaultWorker(ownerId, kind)` and gets the default (or falls back
to highest-priority enabled row, or null).

**Per-agent TTS voice (migration 0066).** You may run _many_ `tts`
workers (only the _default_ is constrained to one per owner). An agent
can pin which voice it speaks with via `agents.tts_worker_id`, chosen in
`/settings/agents` → **Voice (TTS)**. The worker owns provider + voice +
model + key; the agent only references it. The reply path resolves it
through **`getAgentTtsWorker(ownerId, agent.ttsWorkerId)`** (`@mantle/db`):
the pinned worker if it's still owned + enabled, otherwise it falls back
to `getDefaultWorker(ownerId, 'tts')`, so a deleted/disabled/unset pin
degrades to the default rather than going silent. `ON DELETE SET NULL`
means deleting a voice reverts the agents that used it back to the
default.

**`params` is jsonb** because each kind has its own knobs:

```ts
type TtsParams = {
  voice?: 'nova' | 'alloy' | 'shimmer' | ...    // 13 OpenAI voices
  speed?: number                                  // 0.25–4.0
  format?: 'opus' | 'mp3' | 'wav' | ...
  instructions?: string                           // gpt-4o-mini-tts only
}
type SttParams = {
  language?: string
  // A Telegram voice note longer than this (default 180 s) is still
  // transcribed, kept and used whole (owner rule 2026-11-19: everything is
  // consumed in full); the turn says the note is long. No transcript that was
  // paid for is thrown away.
  max_duration_seconds?: number
}
type ReflectorParams = ChatLlmParams & {
  window_size?: number; max_notes_per_run?: number
}
type ExtractorParams = ChatLlmParams & {
  target_types?: string[]; extract_facts?: boolean
  extract_cost_cap_micro_usd?: number
  // (embedding_model removed in 0061 — the embedder is the single
  //  embedding_config row at /settings/embedding, not a per-worker field)
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

`packages/voice/src/adapters/registry.ts`, a `Map<ProviderId,
Dispatcher>` per capability. Built-in adapters self-register on
module load:

```ts
// packages/voice/src/adapters/index.ts
registerTtsAdapter(openAiTtsAdapter);
registerTtsAdapter(elevenLabsTtsAdapter);
registerSttAdapter(openAiSttAdapter);
registerChatAdapter(xaiChatAdapter);
registerChatAdapter(huggingfaceChatAdapter);
registerChatAdapter(anthropicChatAdapter);
registerChatAdapter(googleChatAdapter);
registerEmbeddingAdapter(openrouterEmbedding);
registerEmbeddingAdapter(openaiEmbedding);
registerEmbeddingAdapter(googleEmbedding);
registerEmbeddingAdapter(mistralEmbedding);
registerEmbeddingAdapter(cohereEmbedding);
```

The runtime looks up `getChatAdapter(worker.provider)` /
`getTtsAdapter(worker.provider)` / etc. and calls the right interface.

`isProviderWired(providerId, capability)` reports whether an adapter
is registered for that combination, drives the "not yet wired" hint
in the UI dropdown.

### 3.3 Currently shipped adapters

| Provider              | Chat                                                         | Embedding                                                 | TTS               | STT                           | Vision                              | Image-gen                                           |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------- | ----------------------------- | ----------------------------------- | --------------------------------------------------- |
| OpenRouter            | ✅ (direct SDK¹)                                             | ✅ openrouter-embedding (only multimodal-capable adapter) | ,                 | ,                             | ✅ openrouter-vision (+ native PDF) | ,                                                   |
| OpenAI                | via OpenRouter¹                                              | ✅ openai-embedding                                       | ✅ openai-tts     | ✅ openai-stt                 | ✅ openai-vision                    | ✅ openai-image (gpt-image-1 / DALL-E 3 / DALL-E 2) |
| xAI (Grok)            | ✅ xai-chat                                                  | ,                                                         | ✅ xai-tts        | ✅ xai-stt                    | ✅ xai-vision                       | ✅ xai-image (grok-imagine-image)                   |
| Hugging Face          | ✅ huggingface-chat                                          | ,                                                         | ,                 | ,                             | ,                                   | ✅ huggingface-image (FLUX-1, SDXL, SD 3.5)         |
| Anthropic (direct)    | ✅ anthropic-chat¹                                           | , _(provider defers to Voyage AI)_                        | ,                 | ,                             | ✅ anthropic-vision                 | ,                                                   |
| Google (Gemini)       | ✅ google-chat                                               | ✅ google-embedding                                       | ✅ google-tts     | ✅ google-stt                 | ✅ google-vision                    | ✅ google-image (Imagen 3 / 4)                      |
| DeepSeek              | ✅ deepseek-chat                                             | ,                                                         | ,                 | ,                             | ,                                   | ,                                                   |
| Mammouth (aggregator) | ✅ mammouth-chat (cost from catalog rates)                   | ,                                                         | ,                 | ,                             | ,                                   | ,                                                   |
| Microsoft Foundry     | ✅ foundry-chat (deployment names; [foundry.md](foundry.md)) | ,                                                         | ,                 | ,                             | ,                                   | ,                                                   |
| Mistral               | ,                                                            | ✅ mistral-embedding                                      | ,                 | ,                             | ,                                   | ,                                                   |
| Cohere                | ,                                                            | ✅ cohere-embedding                                       | ,                 | ,                             | ,                                   | ,                                                   |
| ElevenLabs            | ,                                                            | ,                                                         | ✅ elevenlabs-tts | ✅ elevenlabs-stt (Scribe v1) | ,                                   | ,                                                   |
| Deepgram              | ,                                                            | ,                                                         | ,                 | ✅ deepgram-stt               | ,                                   | ,                                                   |
| AssemblyAI            | ,                                                            | ,                                                         | ,                 | ✅ assemblyai-stt             | ,                                   | ,                                                   |

¹ **Every chat provider has a registered adapter, including OpenRouter
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
`extract_from_image` tool for on-demand OCR. The **Vision** column doubles as
the **Document (PDF) `kind`** provider set; adapters with `extractDocument`
(Anthropic, OpenRouter today) read PDFs natively, the rest rasterize. See
§5b′. With only an OpenRouter key the whole text+vision brain works; TTS/STT/
image-gen still need a direct provider (§5b″).

Image-gen providers power **Saskia's `generate_image` tool**,
generated images land both inline in the chat (Telegram `sendPhoto`
on Telegram, base64 artifact in /assistant) and as a file node under
`/files/generated-images/<yyyy-mm-dd>/`.

### 3.4 The provider catalogue

`packages/voice/src/providers.ts`, closed-set list of every provider
Mantle knows about (12 today). Each entry has `id`, `label`,
`description`, `capabilities[]`, `signupUrl`, `docsUrl`,
`isAggregator?`. Drives:

- `/settings/api-keys` dropdown (which services can a key be for)
- `/settings/ai-workers` provider dropdown (filtered by the worker's
  kind via `providersForCapability(cap)`)
- The signup-link hint shown when a provider is selected

Adding a provider, five steps:

1. Add an entry to `SUPPORTED_PROVIDERS`. Provider appears in
   dropdowns immediately (with "not yet wired" hint).
2. Write the catalog file (`catalogs/<provider>.ts`) listing known
   models with capabilities + pricing.
3. Write the adapter (`adapters/<provider>-<capability>.ts`)
   implementing the relevant dispatcher interface.
4. Register it in `adapters/index.ts` (one line).
5. Add wire-shape tests (`adapters/<provider>-<capability>.test.ts`)
   so the audit-caught silent-drop patterns don't recur.

UI lights up automatically once the adapter registers, "not yet
wired" disappears, model dropdown populates, test buttons work.

**For the cookbook with per-capability templates, the OpenAI-compat-
vs-native decision tree, and the audit-caught gotchas to avoid,
read [`docs/adding-a-provider.md`](./adding-a-provider.md).** AI
agents working in `packages/voice/` get the local pointer
auto-loaded from
[`packages/voice/CLAUDE.md`](../packages/voice/CLAUDE.md).

---

## 4. Discovery: finding which models your key can use

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

Implemented per-adapter via the optional `discoverModels(credential)`
method. Soft-fails to the static catalog if the call errors (with a
"couldn't verify" hint in the UI). Each provider's discovery shape:

| Provider     | Endpoint                   | Notes                                                       |
| ------------ | -------------------------- | ----------------------------------------------------------- |
| OpenAI       | `GET /v1/models`           | Flat list of `{id, owned_by}`; filter by name prefix        |
| xAI          | `GET /v1/models` (assumed) | OpenAI-compat; falls back if not present                    |
| Hugging Face | `GET /v1/models`           | Returns hundreds; we curate via catalog filter              |
| Anthropic    | `GET /v1/models`           | Returns dated + alias ids; we match against both            |
| Google       | `GET /v1beta/models`       | Filter to `supportedGenerationMethods: ['generateContent']` |
| ElevenLabs   | `GET /v1/models`           | Plus `GET /v1/voices` for the cloned-voice picker           |

The UI re-runs discovery when the API key OR the provider changes.
Manual refresh button on the model dropdown for "I added a new model
in the provider console, pick it up now."

---

## 5. Voice in/out: end-to-end

The voice-modality pipeline is the most worked-out example of how
`ai_workers` + adapters compose with the responder. Inbound and
outbound both route through workers:

### 5.1 Inbound

```
1. User sends Telegram voice note
2. server/web/workers/telegram-poll.ts ingests via Telegram getUpdates
3. INSERT telegram_messages row with text='(voice message)' and
   attachments=[{kind: 'voice', file_id: '...'}]
4. pg_notify('telegram_message_inserted') fires
5. server/api/src/main.ts handleMessage receives it:
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
template, see [memory.md §6.2](./memory.md#62-the-agent-roles) for
where that lives.

### 5a″. Transcription (STT) options

Thinner than TTS by nature: the normalized surface is a language hint and
nothing else, so every wired adapter declares `supports: ['language']`. What
diverges is what each provider hands BACK.

| adapter          | language hint                                 | returns detected language    | returns duration          |
| ---------------- | --------------------------------------------- | ---------------------------- | ------------------------- |
| `openai-stt`     | ✅                                            | ✅ (`verbose_json`)          | ✅                        |
| `elevenlabs-stt` | ✅ `language_code`                            | ✅                           | ✗ (needs word timestamps) |
| `deepgram-stt`   | ✅, else `detect_language=true`               | ✅                           | ✅                        |
| `assemblyai-stt` | ✅ `language_code`, else `language_detection` | ✅                           | ✅                        |
| `xai-stt`        | ✅                                            | ✅                           | ✅                        |
| `openrouter-stt` | ✅                                            | ✗ (response is text + usage) | ✗                         |
| `google-stt`     | prompt text, not a parameter                  | ✗                            | ✗                         |

The 2026-08 docs sweep found two faults, both in `xai-stt`, both of the same
kind as the TTS ones, a comment asserting something about someone else's API
that had stopped being true:

- `format=true` (punctuation and capitalisation) **requires** `language`. It
  was sent unconditionally, so the common auto-detect path carried a flag the
  request could not satisfy. Formatting is now enabled only alongside a
  language.
- The response carries `{text, language, duration, words[], channels[]}`. A
  comment claimed it echoed neither language nor duration and both were
  discarded, so an auto-detected language never reached `/traces` and the
  duration cap had nothing to check. Both are now read, and the cap applies.

`whisper-1` stays the OpenAI default deliberately. The gpt-4o transcribe models
are newer, but they reject the ogg/webm containers that Telegram voice notes
and browser recordings arrive in, which is our main inbound path.

### 5a′. Which speech options actually reach the provider

The normalized option set (`SynthesizeOptions`) is `text`, `voice`, `model`,
`speed`, `format`, `instructions`, `language`. That set is stable, the AI
SDK's `generateSpeech` arrived at the same seven independently, but **who
honours what is not**, so each adapter declares `TtsDispatcher.supports` and
the caller reports the rest. Checked against each provider's own docs,
2026-08:

| adapter          | forwards                    | notes                                                                                                                     |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `openai-tts`     | speed, format, instructions | no language field at all; `instructions` is ignored by `tts-1` / `tts-1-hd`, which warns per-model                        |
| `openrouter-tts` | speed, format, instructions | OpenAI-compatible `/audio/speech`                                                                                         |
| `elevenlabs-tts` | speed, format, language     | speed rides inside `voice_settings`; `language_code` is refused by the `multilingual_v2` family, which warns per-model    |
| `xai-tts`        | speed, format, language     | speed band is 0.7–1.5, narrower than OpenAI's; out-of-band values clamp and warn                                          |
| `google-tts`     | format                      | Gemini TTS has **no** speed, instructions or language parameter: delivery is steered by prompt text and inline audio tags |

Two corrections that came out of that check, both of which had made an
operator's saved setting silently inert:

- `xai-tts` carried a comment asserting "the speed knob doesn't exist on Grok
  TTS" and never sent the field. It does exist.
- `elevenlabs-tts` never sent `language_code`, and our own option doc said
  ElevenLabs ignored language outright. That is true only of the model we
  happened to default to.

Anything requested and not forwarded comes back as `ignoredParams` on the tool
result and `ignored_params` in the trace step, same convention as image
generation.

### 5a. Speech tags: inline + wrapping

Voice models expose two tag vocabularies, and the framework treats both
uniformly (see `packages/voice/src/adapters/types.ts`, `AudioTag` and
`WrappingTag`):

- **Inline tags**: point-in-time cues in square brackets: `[laughs]`,
  `[sigh]`, `[pause]`. Advertised per-model via
  `TtsDispatcher.supportedAudioTags(model)`.
- **Wrapping tags**: angle-bracket pairs that style a whole phrase:
  `<whisper>it's a secret</whisper>`, `<soft>…</soft>`, `<slow>…</slow>`.
  Advertised via `TtsDispatcher.supportedWrappingTags(model)`. **xAI
  Grok voice** is the provider that ships these today (volume / pitch /
  pacing / style). ElevenLabs and Google were audited and express
  everything through inline tags + natural-language steering, so they
  return `[]`.

Both flow the same way each turn:

1. The runtime asks the active TTS adapter for both sets and folds them
   into Saskia's system prompt via `composeAudioTagInstructions(inline,
wrapping)`, one combined paragraph, grouped by category, so she only
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

Every file that enters Mantle, uploaded via the Files UI, attached to a
`/assistant` turn, sent to the Telegram bot, dropped on disk, or pushed
through MCP, is handled by **two cleanly-separated responsibilities**:

1. **Durable indexing (universal, async).** Save bytes → `node_ingested` →
   the **extractor** is the _single_ producer of durable metadata
   (`data.text` + summary + embedding + facts), type-dispatched: images →
   neutral vision (describe+OCR), pdf/docx/xlsx → `parseDocumentBytes`, text →
   `data.content`. This runs for every file regardless of how it arrived.
2. **Live answer (conversational surfaces only, sync, ephemeral).** The web
   `/assistant` and Telegram run a **question-aware** read of the attachment
   for the immediate reply, never persisted. Both call the one shared helper.

### The shared primitives (no duplication)

- `parseDocumentBytes(bytes, ext)`, `@mantle/files`. The one place that maps
  format → parser. Used by the extractor and the live-answer helper.
- `runVisionWorker({ ownerId, bytes, mimeType, filename, prompt? })`,
  `@mantle/runtime`. Resolves the owner's default vision worker,
  transcodes HEIC, runs the adapter. Best-effort: returns `ran:false` + a note
  rather than throwing. Used by the extractor (neutral) and the live-answer
  helper (question-aware).
- `extractAttachmentForTurn({ ownerId, bytes, mimeType, filename, question? })`
  , `@mantle/runtime`. The conversational helper: image → vision, doc →
  `parseDocumentBytes` (capped at `DOC_TEXT_MAX` 24K), returns
  `{ kind, text, note }`. Used by both `/assistant` and Telegram.
- `buildAttachmentContextText(text, { kind, transcript, note, nodeId })`,
  folds the extracted text into the turn with the file node id surfaced so
  Saskia can re-read the original (`extract_from_image` for images,
  `file_read` for documents).

### Per-surface flow

- **Web `/assistant`** (`processUpload`): save to
  `/files/auto-filed/assistant-uploads/<month>/` → `extractAttachmentForTurn` → fold into
  the turn. Images also echo an inbound artifact so the bubble renders them;
  documents render a client-side file chip. Accepts images + documents
  (pdf/docx/xlsx/csv/txt/md/json/yaml); anything else → 415.
- **Telegram** (`handleMessage`): a `photo` OR `document` attachment →
  `downloadTelegramFile` → save to `/files/telegram-uploads/<date>/` →
  `extractAttachmentForTurn` → fall through to the responder. **Full parity
  with the web**; documents are no longer dropped. (`voice` still routes
  through STT; `audio`/`video` are not yet handled.)
- **Files UI / disk-watcher / MCP**: save only, no inline pass. The extractor
  picks them up and produces the durable index (images via `runVisionWorker`,
  docs via `parseDocumentBytes`).

**Transcript-default + reliability.** The responder prefers the extracted
text; for an _image_ with no transcript it falls back to inlining the raw
pixels only when the model is vision-capable and the image is within the
provider's per-image limit (`maxImageBytesFor`, guards Bedrock's opaque
"Could not process image" on oversized photos). On any responder error with an
image attached, the web turn retries once text-only. Extraction failures fall
back to a `[… couldn't be read: <reason>]` marker. A misconfigured/missing
vision worker leaves an image findable by filename and records the reason on
the `photo_ingest` trace; the system stays up; enrichment is best-effort.

**HEIC/HEIF (iPhone default).** Vision providers can't read HEIC, so
`runVisionWorker` runs `transcodeImageForVision` (`@mantle/files`) first,
HEIC/HEIF → JPEG via `heic-convert` (libheif WASM, no native dep), passthrough
otherwise. Lazy-imported; on a decode failure it returns the original bytes and
degrades as before. `heic-convert` is in `serverExternalPackages` so Next
leaves its `.wasm` alone.

---

## 5b′. The Document (PDF) worker + native PDF (2026-05-28)

A dedicated `kind='document'` worker, separate from `vision`, plus a
native-PDF extraction path. This is the lever that turned "Mantle can't read a
scanned invoice" into "Mantle reads every line."

### Why a separate kind (not just the vision worker)

You pick the _image_ model and the _document_ model differently. A cheap model
(`gpt-4o-mini`) is fine for "describe this photo"; an invoice or statement wants
a strong document model (Claude / Gemini) that reads the **whole PDF natively**,
real layout, real tables. Forcing one worker to serve both means either
overpaying for photo describe or under-reading documents. So `document` is its
own kind with its own provider / model / prompt. Migration `0051` adds it to the
`ai_worker_kind` enum; `DocumentParams` carries `extraction_prompt`,
`max_tokens` (default **8000**: the whole doc transcribes in one call, so the
per-image vision default is far too small), and `prefer_native`.

### Native PDF vs rasterize, and why native is better

Two ways to turn a PDF into text for a vision model:

1. **Rasterize → page OCR** (the original path): render each page to PNG
   (`parserRasterizePdf`: the parser service renders with `@napi-rs/canvas`,
   [parser.md](parser.md)) and run
   the vision worker per page. Works anywhere, but loses cross-page table
   coherence, repeats page headers/footers, and costs N calls.
2. **Native PDF** (the upgrade): hand the _whole_ PDF to a document-capable
   model in **one** call; it reads the text layer AND the rendered pages with
   whole-document context. Better fidelity on dense tables, fewer calls, no
   PNG-conversion loss.

Native is an **optional adapter capability**: `VisionDispatcher.extractDocument`
(`packages/voice/src/adapters/types.ts`). Anthropic implements it (a `document`
content block, `anthropic-beta: pdfs-2024-09-25`, 32 MB cap, 120 s timeout);
OpenRouter implements it (OR's `file-parser` plugin, `engine: 'native'`, routes
to Claude/Gemini under the hood). Providers without it (OpenAI, xAI) omit the
method and the caller **falls back to rasterize → page OCR** automatically.

`runDocumentWorker` (`@mantle/runtime/attachments`) resolves a `document`
worker first, **falling back to the `vision` worker** when none is configured,
so PDFs keep working out of the box; the dedicated worker is purely additive.

### Where it's wired (both layers)

- **A PDF with no text layer** (a scan) is no longer read natively nor by
  page OCR: since the Scan reader's second branch it is the Scan reader's,
  page by page, in the live turn and in the indexer alike (section "Scanned
  PDFs outside a book" below).
- **Live turn** (`extractAttachmentForTurn`, web `/assistant` + Telegram):
  `parse_document` (cheap text); with `prefer_native`, the native read of a
  PDF with a text layer (the `extract_document` trace step).
- **Indexer** (`nativeReadPdfNode`, server/api/src/agent/extract/images.ts):
  the native read of a PDF with a text layer under `prefer_native`, flagged
  `native_pdf: true`. A native read that found no text is kept as
  `native_pdf: { empty_sha256 }`, so a retry of the same bytes does not pay
  for it again; the text layer is kept.

**The bug this fixed.** Before this, the live turn ran _text-only_ PDF parsing
with no OCR fallback, a scanned invoice (no text layer) came back "No text
could be extracted," even though the indexer already rasterized+OCR'd it. The
asymmetry was real and trace-confirmed (`parse_document chars_out:0` → dead end
on the live path). Native PDF + the OCR fallback closes it on both layers.

### `prefer_native`: for digital PDFs with messy tables

By default native/OCR only fires when there's **no text layer** (digital PDFs
use the cheap text path). But a digital invoice can have a _complete but
scrambled_ text layer that mangles columns. The document worker's
`prefer_native` toggle says "always send PDFs to the model, even with a text
layer." Honoured on **both** the live turn and the indexer (the latter via
`documentWorkerPrefersNative` → `nativeReadPdfNode` on text-layer PDFs, keeping
the text body if native yields nothing; no page read of a typed PDF). Off by
default; it costs one LLM call per PDF.

### Cost

A scanned ~5-page invoice on `claude-sonnet-4-6` is ~$0.06 per native
extraction (≈8 K in / 2.4 K out). Note: each upload extracts twice (the live
turn for the immediate reply, the indexer for the durable copy), consistent
with the two-layer design images already use. Direct-provider vision/document
calls pass the **bare** model id (`claude-sonnet-4-6`); the `pricing.ts`
lookup reads the bare id and the dotted OpenRouter slug as one row
(`priceKey`), otherwise spend read $0 in `/debug`.

### The native-capability source of truth

"Which providers read PDFs natively?" is a fact about **our adapter code**, not
something a provider API advertises. `nativeDocumentProviders()`
(`adapters/registry.ts`) derives it live from the registry, the providers whose
vision adapter implements `extractDocument`. Computed server-side, passed to the
worker form, which badges non-native providers `— page-OCR fallback`. Add a new
adapter's `extractDocument` and it appears automatically, no second list to
keep in sync. Today: `['anthropic', 'openrouter']`.

## 5b″. OpenRouter coverage: "one key, the whole brain"

OpenRouter is the lowest-friction setup: with **only** an OpenRouter key, the
entire text + vision brain is functional.

| Capability                                         | OpenRouter? | Notes                                                        |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| Chat (responder, extractor, summarizer, reflector) | ✅          | `openrouter-chat` adapter                                    |
| Embeddings                                         | ✅          | `openrouter-embedding` adapter                               |
| Vision (image OCR)                                 | ✅          | `openrouter-vision.extract`, `image_url` content             |
| Document (native PDF)                              | ✅          | `openrouter-vision.extractDocument`, OR `file-parser` plugin |
| TTS (voice out)                                    | ✅          | `openrouter-tts`, `POST /api/v1/audio/speech`                |
| STT (voice in)                                     | ✅          | `openrouter-stt`, OpenAI-compatible transcription            |
| Image generation                                   | ✅          | `openrouter-image`, `POST /api/v1/images`                    |

**This table used to read ❌ on the last three rows**, and the prose called the
gap "real, not an oversight". It is no longer either: OpenRouter has since
shipped speech, transcription and a dedicated images endpoint, all three are
wired as adapters, and the provider catalogue declares
`capabilities: ['chat', 'embedding', 'vision', 'tts', 'stt', 'image_gen']`. A
single OpenRouter key now covers every worker kind Mantle has. Direct provider
keys remain useful for quality or price (ElevenLabs voices, Deepgram
transcription, Imagen), not because anything is missing.

---

## The Scan reader

A `kind='scan_reader'` worker (migration `0390`) that reads the text of a
scanned page for about half the price of the vision worker. It is an OCR
engine, not a chat model: OpenRouter's PDF parser `mistral-ocr`, fixed
(`SCAN_READER_ENGINE`, packages/runtime/src/agent/scan-reader.ts), whatever
the worker says (owner decisions of 2026-11-19, on the scan bench below).

**A book's pages** (the book reader of large PDFs, docs/pipelines.md "The
book reader"):

1. a page with a usable text layer: its text (free), as before;
2. a scanned page: ALWAYS the Scan reader, on the page cut as a one-page PDF.
   No local OCR (Tesseract) first: "quality is of too much importance,
   let's hit the worker always";
3. a read the check below judges bad: the page is `unread`. No vision call;
4. a brain with no Scan reader (no OpenRouter key, or no worker): its
   scanned pages are `unread`, and the file's status says why
   (`bookPages.noScanReader`). No Tesseract fallback;
5. a page the engine finds mostly a figure (a picture, under 40 characters
   of text): vision describes it, one call more (a picture description, not
   a backup read).

How each page was read (text, OCR of an older read, blank, Scan reader,
vision, unread) is counted live from the book's database and shown in the
file's processing details (`bookPages`, `file_processing`). A PDF outside a
book with no text layer, and a scanned PDF attached in chat, are the Scan
reader's too (below). Photos, screenshots and drawings keep vision.

**The wiring.** The book reader `pdf-pages` (1.3.0) runs no OCR: a scanned
page is drawn at 150 dpi only to count its text lines from its ink
(`band_lines`) and marked `vision`, Why `scan`, with its `Lines`. The Agent
`pdf-page-read` (1.2.0) cuts each such page as a one-page PDF beside its
picture (a page whose PDF cannot be sent is not asked: unread, with a
warning). The core's paid ask (`pipelineAskOf`,
server/api/src/agent/extract/pipeline-ask.ts) reads it with `runScanReader`:
a good read is the page's text (the row's Model `scan_reader:mistral-ocr`);
a bad read is a row with no text (unread; a run again takes the row by hash
and pays nothing); a figure goes on to vision; with no Scan reader the page
is skipped with no stop (`ASK_SKIPPED_NO_SCAN_READER`): the run's other
pages go on, and the run is not marked done, so the next run reads it.

**The worker.** `MANIFEST_WORKERS` entry `scan_reader`, name "Scan reader",
provider `openrouter`, model `SCAN_READER_MODEL`
(`openai/gpt-6-luna`) in
`server/web/lib/system-manifest/manifest.ts`. The model is only the chat
model the parser's text rides on: it answers 16 tokens, which are not
used; the page's text is the parser's own. It is a closed lab model, so
the page text goes only to its maker or to Azure, AWS or Google Cloud,
never to a third-party host of an open-weight model (`manifest.test.ts`
holds every shipped default to that rule). The model takes images, so the
parser also hands it the pictures it cut out of the page (at most 8; a
text-only model gets none), to the same hosts; OpenRouter has no option to
keep them back. A model that refuses after the parse still gives the page:
`parsePdf` takes the parsed text from the error
(`error.metadata.file_annotations`), logs one warn line (the status and the
provider's error code only), and records the parser's fee, which is billed
all the same. The error reports no cost, so the figure recorded is the list
fee (`MISTRAL_OCR_PAGE_USD`, $0.002 a page; $0.0022 in the US region), not
a reported one. Before the release with migration 0397 the model was
`meta-llama/llama-3.1-8b-instruct`, which third-party hosts serve;
migration 0397 moves a worker still on that id to the new one, and the
Scan reader pool's template row with it (a model or a row picked or edited
by hand is kept). `required: true`: it reaches existing brains on
upgrade (the reconcile's required pass), for a brain with an OpenRouter key.
Its model pool is `scan_reader`; its provider eligibility the vision
capability. The worker test reads a one-page PDF (the document test).

**Cost on existing brains** (for the release notes). Every scanned page of a
book now costs the parser's $2.00 per 1,000 pages ($2.20 in the US region)
plus about $0.04 to $0.17 of the chat model (a light to a dense page; up
to about $0.30 when each page has 8 cut-out pictures).
Before, Tesseract read most scanned
pages for nothing and vision (about $3.94 per 1,000) read the ones it read
badly: a book of good scans costs more now, a book of poor scans about half.
A figure page costs the parser and one vision call. With the decider on,
`scan_read_check` adds about $0.27 per 1,000 pages.
Where the page goes: to OpenRouter and on to Mistral (the parser), as a
vision page goes to OpenRouter.

**The call.** `runScanReader` (`packages/runtime/src/agent/scan-reader.ts`):
the one-page PDF in; out, the text, the figures the engine found
(`pictures`, its picture links), the model, the engine, the tokens, the
billed cost and the quality. It calls the vision adapter's `parsePdf`
(OpenRouter: the `file-parser` plugin with the engine, the text from
`message.annotations`, the billed cost from `usage.cost`, parser fee
included) and cleans the parser's markdown (`cleanParsedText`: its `<file>`
wrapper, table divider lines and picture links out, a table row as cells
split by `|`, paired bold marks off). One call a page; with `tries: 2` a
provider that failed with no answer (a timeout, a 5xx) is asked one time
more, never on a refusal and never because the answer read badly. With no
worker it calls nothing (`attempted: false`, `model: null`). The spend is
recorded by the vision adapter on the caller's trace step, at the billed
cost (docs/spend-recording.md).

**Read badly, with no second call.** `scanReadQualityOf`
(`packages/runtime/src/agent/scan-reader-quality.ts`) judges the answer from
what is in hand: the answer itself and the page's text lines counted from
its picture (no local OCR, so no word of Tesseract to compare). A bad read
is any of: no text; `loop` (one line of 8 characters or more over 4 times in
a row); `too_few_lines` (fewer lines than 80% of the 10 or more the picture
shows; an answer's lines are the more of its own lines and its characters
over 45, as the engine writes a prose paragraph as one line); `illegible`
(over 5% of the words are `[?]`); `unverified` (more lines than 1.5 times
the picture shows, and over 10, counting a paragraph by its characters over
80): the made-up page. `short` (under 40 characters) is judged only with no
line count: a scanned divider of a few words is read whole. The decider's
`scan_read_check` (docs/decisions.md) asks Jev whether the read is faithful
to the page picture where its answer can matter (no other bad reason): LIVE
at 0.5 on fresh brains (owner decision 2026-11-19), so a read it rejects is
stored as unread, never as text, and an `unverified` read it calls faithful
stands. With no answer (Jev failed, the use off) the free checks decide.
**Existing brains without the decider worker get only the free checks**:
the decider is optional, an upgrade never adds it, and an operator adds it
(with `scan_read_check` live) to have Jev check their scanned pages.

**The bench** (2026-11-19, made-up pages only; four sets of 12 copies of the
generated spec book; mistral-ocr with the earlier carrier, Llama 3.1 8B,
whose share of the cost was about $0.03 per 1,000 pages; with
`openai/gpt-6-luna` it is about $0.04 to $0.17, so mistral-ocr's row reads
about $2.04 to $2.17):

| reader                                 | cells found: clean / fair / poor / bad | judged bad (no local OCR) | per 1,000 pages | s a page   |
| -------------------------------------- | -------------------------------------- | ------------------------- | --------------- | ---------- |
| Tesseract (no longer in the book path) | 92.9% / 38.7% / 2.7% / 0.3%            |                           | $0              | ~3 (CPU)   |
| mistral-ocr (shipped)                  | 100% / 100% / 99.9% / 0.1%             | 0 / 0 / 0 / 12            | $2.03           | 3.7 to 5.0 |
| gemini-3.1-flash-lite                  | 100% / 100% / 100% / 2.0%              | 0 / 0 / 0 / 12            | $2.43           | 5.4 to 6.1 |
| gemini-3.5-flash-lite (vision)         | 100% / 100% / 99.9% / 0.0%             | 0 / 0 / 0 / 10            | $3.94           | 3.5 to 5.7 |

On the bad set every reader fails; mistral-ocr and the cheap model wrote a
whole made-up spec table onto those pages, and the line rules catch all 12
(`unverified`; a loop on 3). What the line rules cannot see: a plausible
read with the right line count but the wrong words (a read of another page:
0 of 12 caught by them, 12 of 12 by Jev at 0.5). Jev on the made-up reads:
mistral-ocr 12 of 12, gemini-3.1-flash-lite 11 of 12; true reads 24 of 24
kept; about $0.00027 a page.
`scripts/scan-reader/make_set.py` makes the sets in the parser image;
`scripts/scan-reader/harness.py` scores Tesseract and any OpenRouter model
or PDF parser engine on them (cells, words, characters, the check, billed
cost per 1,000 pages, seconds a page) under a spend cap.

### Scanned PDFs outside a book

A PDF with no text layer that is no book (a drawing set's scan, a file the
router did not name a book, a brain with no pipelines), the maintenance
`ocr-rescan` and `blank-scans` that read such files again, and a scanned PDF
attached in chat are read the book's way (owner decision 2026-11-19, "Non-book
PDFs + chat"): the Scan reader, every page, with no page cap (the old page OCR
read 10 pages by vision and stopped). No native read first, no vision backup.

`readScannedPdf` (`packages/runtime/src/agent/scan-pdf.ts`), one function for
the extractor (`ocrIngestPdfNode`, server/api/src/agent/extract/images.ts)
and the chat turn (`scanPdfForTurn`, ./attachments.ts):

1. the file in page windows of 20 pages (`SCAN_WINDOW`, `pdfWindows`: qpdf,
   any size);
2. each window marked with no model by the book reader's own Reader
   `pdf-pages` (run with `runPackaged`, its tab Pages): a page with a text
   layer is its text, a white page is `blank` (no paid call), a scanned page
   gets its `Lines` (the ink bands), the evidence of the check. A Reader that
   fails leaves every page to the Scan reader with no line count;
3. each scanned page cut as a one-page PDF (qpdf); a page past
   `PIPELINE_ASK_PICTURE_MAX_BYTES` is not sent (`too_large`);
4. `runScanReader` (`tries: 2`), 4 pages at once (`SCAN_PAGES_AT_ONCE`), and
   the verdict `scanVerdictOf`, the same function the book's paid ask uses
   (pipeline-ask.ts): judged good, the page's text; judged bad, `unread`;
   mostly a figure, one vision call on the page's picture (drawn by the
   parser then); the decider's `scan_read_check` asked where no free rule
   finds fault but `unverified`.

Each page ends `text`, `blank`, `scan_reader`, `vision` or `unread` with a
reason (`ScanUnreadReason`, packages/files/src/read-cut.ts): `bad_read`,
`no_scan_reader`, `failed` (no answer), `too_large`, `figure` (mostly a
figure, and vision gave no description of it), `not_cut`, `time` (a chat
turn's budget). The file's status says them: `data.ocr` is `true` for a
whole read, else `{ pages_read, pages_total, unread: { <reason>: n } }` and
the file is `partial` with one sentence per reason (extractionOf). A scan
that read no text records the `no_text_layer` skip with the reasons (the
stamp's `pages`), terminal only when every page is final (read, blank, read
badly, too large, a figure not described); a page with no Scan reader yet,
no answer or not cut leaves the file to be read again (`scanPageFinal`,
`SCAN_RETRY_REASONS`). A brain with no Scan reader says so (an OpenRouter key and
the worker); nothing falls back to vision or a native read.

**Money.** One paid call a page (two only when the provider gave no answer).
The parser's work of a window (its cut, marks and page cuts) is done before
the window's first paid call, so a busy parser fails the extract (pg-boss
retries it) with nothing of that window paid. The final pages are kept on
the node as they are read (`data.ocr.scan`, the shared reads below), and a
read again (a retry after a busy parser, a restart, the job's time, or the
drain after a Scan reader is added) reads only the pages not kept (`done`,
windows cut only where such a page is: `pdfWindowsAt`): no page is paid for
twice. A read with no text and every page final drops them (a person's read
again starts afresh), as does the read's end, but while a chat turn reads
them.

**The provider's "not now"** (docs/provider-http.md, "When the provider
refuses for now"). A rate limit or a busy provider on a page is waited
through on that page (`callThroughWaits`, none in a chat turn) and the same
call made again. Still "not now", or no credit: no page after it is sent;
the page and the rest are `unread`, `failed` (not final), and the extract
throws `ProviderWaitError`, so the queue sends the job again later. The pages
read before the wait are kept on the node, so that try reads only the rest.
Every paid answer is kept before the wait (docs/provider-http.md, "Kept
answers"), so a figure whose vision call waits takes its Scan reader answer
on the try again and makes only the vision call; nothing is counted. A
page kept by a book as a pending figure is read by its vision call alone,
whoever reads it. A keep that does not reach the node (gone, other bytes, a
whole read on it) makes the read moot: it stops, with no wait. A chat turn
says the pages it did not read and that the provider is waiting.

**Shared reads** (owner decision 2026-11-19, "Share the reads";
`packages/runtime/src/agent/scan-share.ts`). The chat turn that got a file,
the background extract of it, and a book's paid ask of it read the same
upload: each page's read is kept on the file's node by the sha256 of its
bytes and the page number (`data.ocr.scan`: `pages`, `claims`, `total`,
`chat_until`), whichever reads it first, and the others take it. Before a
paid call a reader claims the page under the node's row lock (one claim
wins); a page another reader holds is waited for (the chat turn to its own
time; the extract to the end of the claim, then claims it again). A claim
ends at its time (a reader that died), and a reader's own claim of a try
before is its own. Each page is kept as its read ends (a waiting reader has
it then), and only final pages are kept (a page with no answer is read again
by the next reader). A whole read's mark (`ocr: true`, or the core's object
with `scan_read`) is never written over; the chat turn's end drops the
shared pages beside it, so the node holds its text once. A book's ask writes nothing there unless a chat
turn reads the file (`chat_until`): a book's rows are its record, and a
write per page would rewrite the whole node; while one does, its pages are
claimed and kept too. A chat turn whose file the background read already
read whole takes that read (its text and its `ocr` mark), with no call. The
store is system work (`system(scan:share)`, `ocr` being a key only the brain
writes) and only on the turn's own saved file, of the bytes in hand: a node
of other bytes shares nothing. A turn with no saved file has no background
read to share with and reads alone. A picture drawn after a paid call (a figure,
the check) that fails is no throw: the figure page is unread, the free rule
stands. No new trigger: the extract runs on an upload as before, and
`ocr-rescan` / `blank-scans` stay person-started (dry run first; their
estimate is the Scan reader's price for every page, the worst case every
page a figure).

**Chat.** The turn reads for `TURN_SCAN_MS` (60 s) from page 1, then stops
starting pages: the note says how many of how many were read, each reason
for the rest (`time` for those not reached), and that the saved file is read
whole in the background by the extractor. A busy parser mid-file keeps what
was read and says the rest. Per page, not the whole file in one call: the
engine's price is per page either way, and only per page does each page get
the check (a page read badly is left out of the answer, never shown as the
page) and a figure its description. KISS over queueing: nothing replies
later by itself (that would start model work with no person), and the
durable read already reads the whole file. The turn and the background read
share their pages (above): one paid call a page between them.

**Measured** (2026-11-19, the generated 140-page scanned spec book, the
large-PDF e2e set: marks and cuts in the parser image on a workstation, the
paid calls from the Mac with the bench key): 140 of 140 pages read by the
Scan reader, every true table cell found (100%), $0.284 billed in all:
**$2.03 per 1,000 pages** (with the earlier carrier, Llama 3.1 8B; with
`openai/gpt-6-luna` about $2.04 to $2.17); a call 3.75 s median, 4.79 s at p90, 4 at once.
The marks and cuts took 16.8 s for the 140 pages on 2 CPUs. A chat turn on
it read 56 pages in its 60 s (63 s wall) and said the 84 others.

---

## 5c. Image generation: out

Saskia generates images via the `generate_image` builtin tool. The
tool resolves the default image_gen worker, calls the adapter, and:

- Saves the bytes to `/files/generated-images/<yyyy-mm-dd>/<unix-ms>-<slug>.<ext>`
  (auto-creates the folders, idempotent on race).
- On Telegram surface: `sendPhoto` with the prompt as caption.
- On /assistant surface: emits an image artifact the chat page renders
  inline in the reply bubble.
- Returns to the LLM: `{nodeId, storagePath, model, adapter, mimeType,
bytes, revisedPrompt?, inlineRef, appliedParams, ignoredParams?}`, enough
  metadata for Saskia to mention what she sent, and `inlineRef` is the
  paste-ready `![alt](media:<id>)` for placing it in a reply or a page.

### Who decides size, style and quality

Two layers, and the split is deliberate.

1. **The worker's saved `params`** (`/settings/ai-workers`) are the operator's
   defaults and apply to every generation.
2. **A per-call argument** overrides them for one image, and Saskia is taught
   (skill `visual_answers`) to pass one ONLY when the user asked for it in that
   conversation. A standing preference is a settings change, not an argument.

**What the model is allowed to pass is computed, not described.** A dynamic
schema hook (`registerDynamicSchema('generate_image', …)`, see
`packages/tools/src/dynamic-schema.ts`) rebuilds the tool's parameters once per
turn from the configured worker: options the adapter does not forward are
REMOVED, and the rest become `enum`s of that model's catalog values. So a wrong
size is unrepresentable rather than merely discouraged, and the prose can never
go stale against the worker actually installed.

**Every adapter declares what it forwards** via `ImageGenDispatcher.supports`:

| adapter             | forwards                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `openai-image`      | size, style (dall-e-3), quality (dall-e-3 + gpt-image-1), input images            |
| `openrouter-image`  | size (pixels or a `1K`/`2K`/`4K` tier), aspect ratio, quality, seed, input images |
| `google-image`      | size (snapped to a ratio), aspect ratio, negative prompt, seed                    |
| `huggingface-image` | size (as width/height), negative prompt, seed                                     |
| `xai-image`         | aspect ratio only (no size / style / quality / seed)                              |

Per-PROVIDER is the wrong grain for some of these, so an adapter may also
return `warnings` from a call, the per-MODEL truth only it knows (OpenAI takes
`style` on dall-e-3 and not on gpt-image-1). The tool promotes those from
applied to ignored before reporting.

Anything requested outside that set is reported, never dropped in silence: it
lands in the trace step as `ignored_params` and goes back to the model as
`ignoredParams` so the reply can say what did not apply. This exists because it
already failed the other way; an OpenRouter worker had size, style and quality
saved and displayed, the old chat-completions code path sent none of them, and
nothing recorded the gap.

### Editing an existing image

`input_image_ids` (file node ids, max 4) turns a call into an **edit**: the
prompt then describes the change, not the whole scene. Reaching for a fresh
generation instead does not modify the user's picture, it invents a different
one and bills for it.

- **OpenRouter** sends the references as data URLs in `input_references` on the
  same `/api/v1/images` call.
- **OpenAI** switches endpoint and encoding: `POST /v1/images/edits` as
  multipart, several references under a repeated `image[]` for gpt-image-1, one
  as `image` for dall-e-2. **dall-e-3 cannot edit** and is refused before the
  request goes out.
- Everyone else declares no `inputImages` support, and the tool refuses with a
  pointer at what to switch to. This is the one case that is a hard error
  rather than a warning: silently generating something unrelated is worse than
  failing.

The result is always a NEW file node; an edit never overwrites its reference,
so the original stays available. `editedFrom` on the output and `edited_from`
in the trace record the lineage.

DALL-E 3 surfaces a `revised_prompt` field when the model rewrites
the prompt for safety/quality; this rides through as
`artifact.caption` so the operator sees what the model actually
rendered against.

---

## 5d. Tool-delegation surface: Saskia can call workers explicitly

Workers have **four invocation paths**, deliberately:

1. **Automatic pipeline**: modality-matched (voice-in → voice-out,
   photo → vision ingest, node-save → extractor).
2. **Tool-mediated**: Saskia chooses to invoke a worker mid-turn via
   one of these builtins:
   - `synthesize_speech(text)`, TTS for explicit "send me a voice
     note" requests. Telegram → `sendVoice`; web → audio artifact
     rendered as `<audio controls>` in the reply.
   - `extract_from_image(node_id | telegram_file_id, prompt?)`,
     run vision on a previously-uploaded image or a Telegram file
     reference.
   - `summarize_text(text | node_id, focus?, max_words?)`, run the
     default summarizer worker over inline text or a note body.
   - `translate(text | node_id, to, from?, save?, title?, quality?)`,
     run the Translator worker (section 5d′).
   - `generate_image(prompt, size?, style?, quality?, negative_prompt?)`
     , image generation as documented above.
3. **UI test buttons**: `/settings/ai-workers/<id>` has per-kind
   test surfaces (record mic, pick image, type prompt) so operators
   can verify config without invoking Saskia.
4. **Heartbeat-driven**: a [heartbeat](./heartbeats.md) fires on
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

## 5d′. The Translator (`translator`, 2026-11-19)

One tool, `translate` (`packages/tools/src/builtins-translate.ts`), on the
MCP surface and in two groups: its own `translate` group and
`media-workers`. Owner's decision (2026-11-19, "every workspace"): the
persona, Pages and the Team responder hold `translate`; the Admin
workspace's assistants get it with the persona's default groups; every
other workspace's assistant, the Team responder and hand-made ones alike,
gets it ONCE per agent (reconcileWorkspaceDelegation, recorded as
`group:translate` beside the delegation grant), so an owner's removal
sticks. It spends, so it is no content-kind group.
Owner's rules:

- **Called, never started by itself.** No trigger, timer or sweep runs it.
  A paid call happens only when a person or an agent asks.
- **Everything is translated.** The text is cut into parts at block ends
  (paragraphs, whole tables, whole code blocks; a part starts at a heading
  where it can), and the parts joined are the text, byte for byte. Each
  part is translated, three at a time, and the answers are joined in the
  text's order. Only an answer that finished (`finish_reason: stop`) is
  taken: one that ended with no finish, an empty or far too short one, or
  one from a self-hosted model (`local`, `custom`) that says it read far
  less than it was sent is tried again; an
  answer cut at the output limit is cut in two and each half done again; a
  part that still fails fails the whole call, with which part and why, and
  no other part is sent after that. A shortened text is never returned.
- **Part size is the model's own.** From the live OpenRouter catalog: the
  output limit (`top_provider.max_completion_tokens`, `outputLimitFor` in
  `@mantle/tracing`) and the context window. A part's answer must fit the
  output limit even when the target language takes 2.5 times the tokens of
  the source; the part, the prompt and the answer must fit the window. A
  model the catalog does not know, and every self-hosted model, gets a
  careful 8,192-token window (a local server trims a prompt longer than its
  window by itself).
  `params.part_tokens` asks for smaller parts, never larger ones.
- **Code is never sent.** A closed fenced code block (three or more
  backticks or tildes, closed by the same or a longer run) is always a
  block of its own (a long one a part of its own, never cut), goes to the
  model as a stand-in line carrying a per-call number, and is put back byte
  for byte; an answer that loses or repeats a stand-in is not taken, and a
  part that is only code makes no call. A fence that never closes, or a
  line of tildes used as a separator, is text and is translated. Code the
  stand-ins do not cover (a fence inside a quote or a list item, indented
  code, inline code) goes to the model with the rule to keep it as it is.
- **Layout kept.** The rules ask for Markdown, tables, inline code, links,
  numbers, units and names unchanged. The text is fenced as data.
- **Models.** The worker's own model runs every part (shipped:
  `google/gemini-3.1-flash-lite`). `params.fallback_model` (shipped:
  `openai/gpt-6-luna`) takes a part only when the primary fails
  it: an error, a refusal, an empty or far too short answer, or one cut at
  the output limit. `params.high_model` (shipped:
  `anthropic/claude-sonnet-5.5`) runs a call that asks `quality: 'high'`
  instead of the worker's model. No part is ever sent twice once it has a
  good answer. The models are ids on the worker's own provider. All three
  are closed lab models, served only by their lab, Azure, Amazon Bedrock
  or Google (endpoints checked 2026-11-24). The fallback is another lab
  than either model it backs, so a refusal is not met again by the same
  lab. Before the release with migration 0398 the fallback and the high
  model were Mistral open-weight models (`mistralai/mistral-small-2603`,
  `mistralai/mistral-medium-3-5`); migration 0398 moves a worker still on
  them, and the pool's two template rows, and keeps a model a person
  picked. Live check 2026-11-24, 6 short made-up passages (English to
  German, English to Japanese, Spanish to English), each model alone:
  every passage finished, with the code, the tags and the numbers kept.
  Cost per passage: GPT-6 Luna $0.0001 to $0.0002 (Mistral Small about
  the same), Claude Sonnet 5.5 $0.0027 to $0.0048 (Mistral Medium $0.0015
  to $0.0025).
- **Rights.** The item is read in the caller's scope (an item it does not
  read answers as a random id, before any spend); mail needs the Connectors
  area of the Admin workspace. `save` writes through the content library,
  whose writes the database checks for the caller.
- **The copy.** A note stays a note, a page a page, anything else (a file,
  an email, pasted text) becomes a page. On the owner's own surface it goes
  beside the original (the same folder); elsewhere at the top level of the
  caller's own workspace, as filing in a folder is the owner's (and where
  the original's folder refuses the write). It carries `data.translationOf` (`{ id, to, from }`),
  not `sourceFileId`: a copy is not reaped with its file. The original is
  never changed. A save that fails returns the translation anyway, with
  `save_error`.
- **A write tool.** It may make a copy, so a read-only login or key cannot
  call it, even without `save`. `save` works wherever the caller may
  write: off the owner's own surfaces the copy is the turn's login's own
  create (the write gateway refuses what that login may not write, and the
  translation is still returned, with `save_error`); a turn that acts for
  no signed-in person (the Team responder with no member, a heartbeat)
  saves no copy.
- **A file's whole text.** A file its reader took only in part (its
  `read_cut` record, a sheet's rows, an OCR that stopped early) is refused:
  nothing is translated, and the reason is named. A small picture left out
  as an icon is a detail only and does not refuse. A stored text cut at the
  extractor's 1,000,000 characters is read whole: the file's pages from its
  database (a PDF book, as `file_read` does), else the parser service once
  more; any cut it reports, or no longer text, refuses. A file no reader
  reads (its stand-in text names the file only) has no text to translate.
- **Budgets.** In a workspace user's turn, a translation that cannot fit the
  user's daily tokens left (estimated on the high side: the text, its
  answer and each part's prompt) is refused before any spend; while a
  budget applies the parts go one at a time and the run stops before a
  part that would pass it. `to` and `from` are a language's name or code
  only (letters, digits in a code, spaces, hyphens, brackets; at most four
  words), and the prompt quotes them as names.
- **No translator worker.** The tool runs on the summarizer worker's route
  with the translation rules (never the summarizer's own prompt or params).
- **Required worker.** It is made on existing brains by the boot reconcile
  (an OpenRouter key needed) and costs nothing until used.

Settings: the AI workers screen (the worker's model and params), and over
MCP `translator_settings` (Settings area of the Admin workspace): reads the
three models and `part_tokens`, or sets any of them after the box policy and
catalog checks. The Control Center's fleet `workerModel` sets the worker's
model too, as for every shipped kind.

**Search languages** (2026-11-24, [`memory.md` 4.1a](./memory.md#41a-words-in-other-languages-search-languages)):
the Translator's model also translates a search query into the brain's
search languages, for the word arm of search. One short call per new query
and language, only when a person or an agent searches; the card sits under
the Translator worker on the AI workers screen, and over MCP it is
`search_languages`.

## 5e. Embedding: the cross-cutting kind

> **⚠ SUPERSEDED (migration 0061).** Embedding is **no longer an ai-worker
> kind**. It moved to a dedicated singleton, the `embedding_config` row, edited
> at `/settings/embedding`, with one model, one dimension, and a primary +
> same-model **backup route** (failover). The per-agent / per-extractor /
> env overrides described below are all **removed**; `resolveEmbeddingConfig`
> reads only the one row. The adapter-dispatch, cache, and discovery mechanics
> in §5e.2–5e.3 still apply (the embedding adapters are unchanged); the
> worker-form / per-kind / override material in §5e.1, §5e.4, §5e.5 is
> **historical**. The current operator guide is [`docs/embeddings.md`](./embeddings.md)
> (see "The one config: /settings/embedding" and "Primary + backup routes").

This section covers the runtime mechanics, how dispatch resolves, how
the cache works, what the rebuild button is wired to. For **which
embedding model to pick and why** (operator-facing decision guide,
local Gemma vs cloud large/gemini/cohere with the benchmark numbers + the
768-dim constraint), see [`docs/embeddings.md`](./embeddings.md).

Added in migration `0047_ai_worker_kind_embedding.sql`. Unlike the
other worker kinds (which are each triggered by one signal, `tts` by
voice replies, `extractor` by `pg_notify('node_ingested')`, etc.),
**embedding is read by every memory layer in the stack**:

1. **Extractor write path**: every `node_ingested` produces a vector
   on `nodes.embedding`, `entities.embedding`, `facts.embedding`.
2. **Responder + assistant**: embed the inbound message to retrieve
   semantic memory.
3. **`replay_window` builtin (Remy)**: embeds the query for
   time-windowed semantic search.
4. **MCP `search_chunks`**: Claude Desktop's tool call.
5. **Tool-result spill store `read_result query`**: embeds the query
   against the spilled artifact's chunks (`tool_result_chunks`).
6. **Assistant per-turn retrieval**: same embed-and-search pattern as
   the responder.

Before this kind existed, the model was either env-implicit
(`MANTLE_EMBEDDING_MODEL` or the hardcoded fallback) or set as a
per-worker override on the extractor only. The override field covered
just one of those six call sites, a misleading "this is THE knob"
shape, so embedding got promoted to a first-class kind.

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
just the model slug, because dispatch needs all three to talk to the
right adapter with the right key. A backward-compat `resolveEmbeddingModel`
remains as a thin wrapper for the few callers that only need the model
(the reembed script's logging line).

The resolver caches per-ownerId in-process for 60s, necessary because
the extractor batches embed many texts per ingest, and recall + spill
embed per query. The cache is dropped on `clearEmbeddingModelCache(ownerId)`
which the workers form mutations call after every save / setDefault /
delete that touches an embedding worker. So a model swap kicks in on
the next ingest / recall, not after a TTL.

### 5e.2 Adapter dispatch (Stage 1 of the runtime-honesty push)

`@mantle/embeddings#embed()` was originally hardcoded to OpenRouter's
endpoint with `getApiKey(ownerId, 'openrouter')`, even though the
worker schema carried `provider` and `apiKeyId` fields. **The Stage 1
work landed in [`5dc3984`](https://github.com/crossworks-engineering/mantle/commit/5dc3984)
makes embedding genuinely multi-provider**: the runtime dispatches
through the same adapter registry the TTS/STT/vision/image-gen kinds
use, and the form unlocks the provider dropdown to match.

Five embedding adapters in [`packages/voice/src/adapters/`](../packages/voice/src/adapters/):

| Adapter                | Endpoint                                                          | Multimodal                                         | Discovery                                              |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `openrouter-embedding` | `/api/v1/embeddings`                                              | ✅ (gemini-embedding-2-preview, nemotron-embed-vl) | keyless via `/api/v1/embeddings/models`                |
| `openai-embedding`     | `/v1/embeddings`                                                  | text-only                                          | filtered `/v1/models`                                  |
| `google-embedding`     | `:batchEmbedContents` (model in URL path, key as query string)    | text-only                                          | filtered `/v1beta/models` by `embedContent` capability |
| `mistral-embedding`    | `/v1/embeddings` (OpenAI-compatible)                              | text-only                                          | filtered `/v1/models`                                  |
| `cohere-embedding`     | `/v2/embed` (own shape: `texts`, `input_type`, `embedding_types`) | text-only                                          | filtered `/v1/models`                                  |

Each adapter implements:

- `embed(req)`, translates the unified `EmbedRequest` to the provider's
  native shape, parses the response back to `EmbedResult`.
- `acceptsInput(item)`, text-only adapters return `false` on
  multimodal items so the caller surfaces a clear "use OpenRouter for
  multimodal" error rather than letting the upstream API reject it.
- `discoverModels(credential)`, per-provider catalog fetch, falls back to
  `staticCatalog()` if the API call fails.

The runtime path in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts):

```
embed(ownerId, text) → embedBatch → embedMultimodal
   │
   ├─ resolveEmbeddingConfig(ownerId)       — DB lookup, 60s cached
   ├─ getEmbeddingAdapter(config.provider)  — registry lookup
   ├─ adapter.acceptsInput per input        — text/multimodal guard
   ├─ embedding_cache lookup by (model, content_hash)
   ├─ for misses: apiKey via resolveProviderKey(ownerId, provider,
   │     apiKeyId): the pinned key, else the provider's own key on file
   └─ adapter.embed({apiKey, model, input, dimensions: 768})
```

The cache stays keyed on `(model, content_hash)` so two providers
serving the same slug share entries. Different slugs (OR's
`openai/text-embedding-3-small` vs OpenAI direct's
`text-embedding-3-small`) cache separately; they produce identical
vectors but a cache miss on first use after a provider swap is acceptable.

### 5e.3 Discovery: per-provider

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
concatenates, [`server/web/lib/model-explorer.ts`](../server/web/lib/model-explorer.ts).

Heuristic gotcha worth knowing: 13 of OR's 25 embedding models lack
`embed` in their slug (sentence-transformers, GTE, E5, BGE, MiniLM,
MPNet, paraphrase families). The /models fetcher overrides
`kind: 'embedding'` on the embeddings-endpoint branch unconditionally
; the URL is the source of truth, not the slug pattern.

### 5e.4 Two cliffs, both handled in the form

A model swap can fail in two distinct ways. The form surfaces both:

**(a) Dimension mismatch, column rejects the insert.** Since migration
`0060` the brain has `vector(768)` columns (`nodes.embedding`,
`entities.embedding`, `facts.embedding`, `content_chunks.embedding`,
`tool_result_chunks.embedding`). Switching to a model that emits
anything other than 768 dims (e.g. `text-embedding-3-small` at 1536, or
`-3-large` at 3072 without MRL truncation) would crash ingest on its
first call.

The form has a **"Test dimensions" button** that embeds the string
`'dimension probe'` with the picked model and reads back the actual
vector length. The result populates a per-slug detected-dim cache and
also drives a hand-curated `KNOWN_DIMS` allow-list as a fallback. When
dim is **known and ≠ 768**, the Save button is hard-blocked with a
destructive-banner explanation, switching to a non-768 model needs a
schema migration on every vector column, which isn't a button.

> **⚠ Known gap (2026-05-31):** the form's guard (`COLUMN_DIMS` /
> `KNOWN_DIMS` in [`worker-form.tsx`](<../jackdaw/app/(app)/settings/ai-workers/worker-form.tsx>))
> and the per-agent embedding dropdown still hardcode **1536**, not 768,
> they were not flipped during the 0060 migration. Until fixed, the guard
> is inverted: it blocks the live 768 model and permits the old 1536 ones.
> The runtime is correct (the DB worker row is `local`/768); only the UI is
> stale.

**(b) Vector-space drift, column accepts, retrieval silently breaks.**
Two embedding models with the same dim produce vectors in
_completely different coordinate systems_. Cosine similarity across
spaces is meaningless: existing vectors embedded with model A return
random matches for queries embedded with model B. The column accepts
the inserts; the brain just stops working semantically.

The form has a **"Rebuild Index" button** (edit mode only, gated on
`!modelDirty` so the save commits first) that wraps
[`runReembed(ownerId, opts)`](../packages/embeddings/src/reembed.ts).
The helper walks `nodes`, `entities`, `facts`; re-embeds every row
against the current resolver value; idempotent under the
`embedding_cache` so re-running against the same model is free. Per-owner
in-flight Map prevents double-click / multi-tab waste, the cache key
includes `(ownerId, model, dryRun)`.

The CLI `pnpm re-embed` shares the same code path. The script became a
thin wrapper around `runReembed`; the UI button does the same thing
without leaving the browser.

### 5e.5 The legacy override field

`ExtractorParams.embedding_model` predates this kind. Now relabelled
"Embedding model override (advanced)" with a pointer at the canonical
worker. Kept functional for niche cases (cache preservation during a
migration, historical reproduction) but discouraged, mismatched
embedders across consumers produce silent retrieval degradation, which
is a bigger UX failure than a missing per-worker knob. Same applies to
`agents.memory_config.embedding_model` (responder / assistant per-turn
retrieval override).

The intended path: set the embedding AI worker, leave every override
blank. The resolver picks it up everywhere.

---

## 5f. `max_tokens`: what the 1500 default actually means

Background note for when we revisit the worker form. The `Max tokens`
input on chat-shaped workers (reflector / extractor / summarizer)
defaults to **1500** ([worker-form.tsx:1699](<../jackdaw/app/(app)/settings/ai-workers/worker-form.tsx>));
the vision worker defaults to **2000** ([worker-form.tsx:1328](<../jackdaw/app/(app)/settings/ai-workers/worker-form.tsx>)).
The agents form is different: empty placeholder `(provider default)`,
no number ([agents-client.tsx:1435](<../jackdaw/app/(app)/settings/agents/agents-client.tsx>)).

**Key insight: 1500 is not load-bearing.** It's a UI placeholder, not
a runtime constant. Nothing in the codebase branches on it:

- **Summarizer chunking** uses `summarize_batch` (turn count, default
  20), not tokens. Growing `max_tokens` makes one digest _richer_ but
  doesn't change how often summarization fires.
- **Tool-result spill** uses `TOOL_RESULT_MAX_CHUNKS` (env, 200),
  independent of any worker's `max_tokens`. See §9m of architecture.md.
- **Tool-loop** ([tool-loop.ts:235](../packages/runtime/src/agent/tool-loop.ts#L235))
  forwards the param verbatim if set, omits it if not. Adapters that
  _require_ it default high (Anthropic chat = 4096, vision adapters =
  2000); adapters that don't (OpenRouter, Google, xAI, DeepSeek, HF)
  omit the field and let the provider pick.

So the parameter is genuinely just "ceiling on this one LLM call's
reply length." Growing it is safe; the only cost is the LLM running
longer per call.

**Why 1500 specifically.** Pre-Phase-3 legacy: when everything went
through OpenRouter + Claude Sonnet (4096 hard cap), 1500 left
headroom for input and prevented a runaway summarizer from spending
unbounded tokens on one digest. It made sense as a floor of safety,
not as a ceiling of capability. Post-Phase-3, with adapters going
direct to Anthropic / Google / xAI and Claude 4.x supporting **64K**
output tokens (Gemini 2.5 Pro ~65K, GPT-4o ~16K), 1500 silently caps
summaries and extractions well below what the model could do.

**Why we don't auto-cap from the model catalog (yet).** OpenRouter's
public `/api/v1/models` exposes `context_length` (total input+output)
but **not** `max_completion_tokens`; the field isn't in the response
shape cached by [`model-context.ts`](../packages/tracing/src/model-context.ts).
The per-provider story:

| Provider                 | Max output knowable from a public endpoint?                   |
| ------------------------ | ------------------------------------------------------------- |
| Anthropic                | Yes, in Anthropic's `/v1/models` (e.g. Sonnet/Opus 4.x = 64K) |
| OpenAI                   | Per-model, documented but not in `/v1/models`                 |
| Google (Gemini)          | Yes, `models.get` returns `outputTokenLimit`                  |
| xAI / DeepSeek / Mistral | Documented, not in `/v1/models`                               |
| HuggingFace              | Model-card dependent                                          |

A live cap would need a per-provider lookup table plus opportunistic
reads where `discoverModels()` returns the field (Google does).

**When we come back to this.** Three sized options, in order of
return-on-effort:

1. **S, drop the 1500 placeholder** (~10 LOC). Leave the chat-worker
   field empty by default, matching the agents form. Adapters already
   omit `max_tokens` when unset; the provider picks. Existing workers
   keep their saved value; only new ones change. Highest signal-to-cost.

2. **M, slider against `context_length / 2`** (~80 LOC). Show a
   slider whose max is `Math.min(contextLength * 0.5, 32768)`, a
   defensible heuristic since output rarely exceeds half the context
   window. Reads `contextLimitFor(model)` from the already-cached live
   catalog; no new fetch, no curated table. A tooltip explains "Most
   providers cap below this; we'll surface the real cap once the
   catalog exposes it."

3. **L, true per-provider `max_completion_tokens`** (~250 LOC).
   Extend `LiveModelInfo` with `maxCompletionTokens?: number`. Curated
   table for the 10–15 model slugs people actually use (Sonnet 4.x =
   64K, Gemini 2.5 Pro = 65K, GPT-4o = 16K, Haiku 4.5 = 8K, …). Where
   the adapter's existing `discoverModels()` returns the field, prefer
   it. Slider clamps to the real cap.

Recommendation when we get to it: do **S** first (clears the
misleading number), then **M** (gives operators a visible ceiling that
doesn't lie). Defer **L** until a surprising real-world cap actually
bites; the curated table is the part that goes stale; the slider
against `context_length` doesn't.

**Chunking is not affected by this knob.** Worth repeating because the
question came up: the chunking that _does_ happen, summarizer
batching, tool-result spill, content_chunks at ingest, all use their
own size knobs (turn count, byte size, character count), none of which
read `max_tokens`. So this work is purely about "let the model say
more in one reply when it wants to," not about how content gets
sliced for indexing.

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
  Doesn't persist, for iterating on the per-image prompt before
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
adapter's `discoverModels` as an auth probe, instant green/red on
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
  nothing; there's no "switch Perplexity to a different provider" story.

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
- **Phase 3b** (`148d423`): tool loop refactored, adapter dispatch
  - normalised tool calls across Anthropic / Google / OpenAI shapes.
- **Phase 3c** (`3581f61`): `agents.provider` column (migration 0048).
- **Phase 3d** (`38e2cbc`): forms unclamped. Operators can now
  configure responder + workers for direct Anthropic / Google /
  xAI / HF.

Vision and image-gen adapters have been live since May 2026, see §3.3
for the matrix. Vision plugs into both Telegram photo ingest (automatic)
and Saskia's `extract_from_image` tool (on-demand). Image-gen plugs into
Saskia's `generate_image` tool. Both are wired for OpenAI, xAI, Google,
and (image-gen only) Hugging Face. Anthropic ships vision but no image
generation.

---

## 7a. Chat route failover (primary + backup)

> Full implementation deep-dive: [`docs/chat-failover.md`](./chat-failover.md).

Every **agent** and chat-shaped **ai_worker** can carry a second chat route, a
`backup_provider` / `backup_model` / `backup_api_key_id` (+ `backup_enabled`)
alongside the active `provider` / `model` / `api_key_id` (migration `0062`). The
active columns are always "the primary"; a "make backup primary" UI swap just
exchanges the two sets of values, so the runtime needs no precedence logic.

**Unlike embeddings, the backup may be a DIFFERENT model.** Chat has no
vector-space lock, answering a turn on another model has no correctness cost.
That's the enabler for running a **local** model (e.g. gemma-3 via LM Studio /
Ollama) as the primary for the summarizer / extractor / reflector with a cloud
model as the safety net (or the reverse).

**Failover policy** (in [`packages/runtime/src/agent/chat-failover.ts`](../packages/runtime/src/agent/chat-failover.ts)):

- **Triggers:** a route-DOWN error (connection refused / DNS / timeout), **429**
  rate-limit, or **5xx**: classified by reusing `@mantle/voice`'s
  `classifyChatError` (the same transient/permanent split the per-adapter retry
  wrapper uses). The primary's own internal retries run first; failover only
  fires once those are exhausted.
- **No failover on 4xx** (bad input, context-length, auth): the backup would
  fail identically, so those rethrow.
- **Single-shot workers** (extractor / summarizer / reflector) use
  `chatWithFailover(ownerId, routes, opts)`, try primary, on a trigger call the
  backup. Each invocation starts on the primary again (optimistic, stateless).
- **Tool-loop agents** (responder / assistant / heartbeat / invoke_agent):
  `runToolLoop` takes an optional `backup` route and holds an active-route
  pointer. On a mid-loop trigger it flips to the backup **for the rest of that
  turn** (sticky, no flip-flopping models mid-reasoning); the next turn starts
  on the primary again. A broken backup never breaks the primary path
  (`resolveBackupAdapter` returns `undefined` and logs).

There is **no circuit breaker** (decision: start simple). A primary that
_refuses fast_ (box off) costs ~nothing per turn; a primary that _hangs_ costs
one timeout per turn until it recovers, add a breaker later only if that bites.

**Operator UI + local models (shipped 2026-06-01).** The backup route is
configured from the worker form, a "Backup route" section (provider/model/key +
enable switch) with a **"Make backup primary"** swap. For a `local` route, a
base-URL field + a "Reach via Tailscale" toggle appear (migration `0063`); the
base URL autocompletes from your tailnet peers. So a chat-shaped worker
(summarizer / extractor / reflector) can run a **local model** (e.g. gemma via
Ollama / LM Studio) as its primary with a cloud model as the backup, entirely
from the UI. The `local` provider is **keyless**: key resolution flows through
the shared `resolveChatKey` (pinned → service → `local` sentinel), so a local
worker needs no API key and isn't skipped for the lack of one. Full reference:
[`chat-failover.md`](./chat-failover.md) (§10–§12) + [`tailscale.md`](./tailscale.md).

---

## 8. The configuration surface (operator view)

What an operator needs to do to make every capability work:

1. **At `/settings/api-keys`**, add keys for the providers you want:
   - OpenRouter (required, covers chat for the responder, extractor,
     summarizer, reflector by default)
   - OpenAI (required if you want voice in/out, since the default STT
     and TTS workers point here)
   - Anthropic / Google / xAI / Hugging Face / ElevenLabs as desired

2. **At `/settings/agents`**, configure the conversational agent:
   - Responder (Telegram), the persona the user actually talks to.
     Sets persona, memory depth, system prompt, tool allowlist,
     skills. Points at an OpenRouter key + model by default.
   - Optionally a separate Assistant (web `/assistant`). Falls back
     to responder if not set.

3. **At `/settings/ai-workers`**, configure the one-shot workers:
   - **Reflector**: appends to responder's persona_notes from
     recent dialog. Backfilled from `agents` if you had one.
   - **Extractor**: runs on every `node_ingested`. Backfilled.
   - **Summarizer**: rolls Telegram conversation history into digest
     nodes. Backfilled.
   - **TTS**: required for voice replies on Telegram. Default:
     OpenAI gpt-4o-mini-tts with voice=nova.
   - **STT**: required for voice-message transcription. Default:
     OpenAI whisper-1.
   - **Embedding**: the brain ships configured for `local` /
     `embeddinggemma:latest` (768-dim, keyless, via Ollama). Keep this
     worker row present: without it the resolver falls through env →
     hardcoded `openai/text-embedding-3-small` (1536), which would crash
     ingest against the `vector(768)` columns. The worker row makes the
     model an explicit DB choice and unlocks the form's Test / Rebuild
     affordances. See §5e. _(Note: that cloud fallback default is itself
     a latent footgun post-768, see the §5e.4 known-gap note.)_
   - Vision / image-gen, config saved but dispatch not yet wired.

Each worker has its own model, API key, params. Multiple workers per
kind are allowed (priority + is_default flag picks the winner).

### 8.1 Provider routing today: what goes through what

Every kind dispatches the same way: through the adapter registry, with
the worker's (or agent's) `provider` field driving which adapter
resolves. Phase 3 (commits 97298a5 through 38e2cbc) unified the model.

| Kind                                                                   | Runtime path                                                                                | `provider` field                                              | `apiKeyId` field | API key dropdown filter                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| **TTS / STT / Vision / Image-gen**                                     | Adapter registry, `getXxxAdapter(worker.provider)`                                          | ✅ honoured, picks the adapter                                | ✅ honoured      | filtered to keys whose service ∈ providers declaring this capability           |
| **Embedding**                                                          | Adapter registry, `getEmbeddingAdapter(worker.provider)` (Stage 1, §5e.2)                   | ✅ honoured, picks the adapter                                | ✅ honoured      | filtered to keys whose service ∈ {openrouter, openai, google, mistral, cohere} |
| **Reflector / Extractor / Summarizer**                                 | Adapter registry, `getChatAdapter(worker.provider).chat({...})` (Phase 3a)                  | ✅ honoured, picks the adapter                                | ✅ honoured      | filtered to keys whose service matches the selected provider                   |
| **Agents** (responder / assistant / custom / heartbeat / invoke_agent) | Adapter registry, `getChatAdapter(agent.provider).chat({...})` via `runToolLoop` (Phase 3b) | ✅ honoured, `agents.provider` column added in migration 0048 | ✅ honoured      | filtered to keys whose service matches the selected provider                   |

**What this enables, concretely:**

- An extractor pointed at `provider='anthropic'` + `model='claude-haiku-4-5'`
  routes through Anthropic's /v1/messages endpoint; cache_read tokens
  surface in `/traces`.
- The responder configured for `provider='google'` + `model='gemini-2.5-pro'`
  emits `functionCall` parts for tool use, gets `cachedContentTokenCount`
  from Gemini's implicit caching on /traces.
- OpenRouter is no longer the special case, `openrouter-chat` is just
  another adapter (with the OR SDK as its HTTP layer + cache markers
  flowing through via the SDK's typed `cacheControl` field).

---

## 9. Implementation map

If you're reading the code, the canonical files to start with are:

1. `packages/db/src/schema/ai-workers.ts`, schema + param types
2. `packages/db/src/ai-workers-resolve.ts`, `getDefaultWorker`,
   `bumpWorkerUsage` (shared between server/web and server/api)
3. `packages/voice/src/providers.ts`, provider catalogue
4. `packages/voice/src/adapters/types.ts`, dispatcher interfaces
5. `packages/voice/src/adapters/registry.ts`, registry + lookups
6. `packages/voice/src/adapters/openai-tts.ts`, reference adapter
7. `packages/voice/src/adapters/anthropic-chat.ts`, adapter with
   non-trivial translation (system field, max_tokens required)
8. `packages/voice/src/adapters/elevenlabs-tts.ts`, adapter with
   live voice discovery
9. `jackdaw/app/(app)/settings/ai-workers/worker-form.tsx`, UI
   that ties it all together; reactive provider/model/voice dropdowns
10. `server/api/src/main.ts` (search for `getSttAdapter` /
    `getTtsAdapter`), runtime integration for voice in/out
11. `packages/embeddings/src/index.ts`, `resolveEmbeddingModel`,
    `embed`, `embedBatch`, `clearEmbeddingModelCache`. The resolver
    chain + per-ownerId cache.
12. `packages/embeddings/src/reembed.ts`, `runReembed`, used by both
    the CLI script (`pnpm re-embed`) and the workers form's
    Rebuild Index button.
13. `packages/decisions/src/decide.ts`, the `decider` worker's one door:
    a typed-decision model (choice / score / yes-no with probabilities, no
    prose) that is optional at every level and switched per use in the UI.
    Its own capability (`decision`) and dispatcher, because it is not
    chat-shaped. See [decisions.md](decisions.md).

---

## 10. Future shape

### 10.1 Phase 3: Direct-provider routing for chat-shaped workers + agents

**Status: SHIPPED (May 2026). The work is preserved here for archaeology;
§7 has the final stage list with commit shas. For the post-Phase-3
architecture deep-dive + engineering retrospective (audit findings,
cost math, known sharp edges, reusable patterns), see
[`docs/_archive/phase-3-retrospective.md`](./_archive/phase-3-retrospective.md).**

**What's outstanding.** The chat-shaped workers (reflector / extractor /
summarizer) and all agents (responder / assistant / custom) still
construct `new OpenRouter({apiKey})` directly instead of going through
the chat adapter registry. The forms reflect this honestly today,
clamped to `service='openrouter'` keys with explanatory copy, but
that's the _less ambitious_ end-state. The bigger move is to migrate
the runtime so the `provider` field actually controls dispatch, the
same way TTS / STT / Vision / Image-gen / Embedding already do.

**Why it was deferred.** For a single-user OpenRouter-only install
(today's typical Mantle operator), the cost-benefit is poor:
OpenRouter's chat margin is in the low single digits, the engineering
effort is ~800-1000 LOC, and the user-facing experience already works.
Stage 2 of the runtime-honesty push made the forms honest about the
status quo so an open-source contributor doesn't get confused, that's
the immediate UX win. Phase 3 is the structural move that follows when
either (a) operators ask for direct-Anthropic / direct-OpenAI routing
for cost reasons, (b) a multi-provider failover story becomes useful,
or (c) someone wants to wire Voyage AI for embeddings as a non-OR
embedding provider.

#### Concrete work for Phase 3

Five sub-pieces, mergeable in order. Each is independently shippable.

**3a. Migrate `server/api/src/agent/extractor.ts` to the chat adapter registry**
(~50 LOC). The simplest piece. Replace `new OpenRouter({apiKey})` with
`getChatAdapter(worker.provider).chat({...})`. The chat dispatchers
already exist (xai-chat, huggingface-chat, anthropic-chat, google-chat
in `packages/voice/src/adapters/`), they just aren't called from
production. The extractor's chat call is a single turn, no tool
loop, so the call-site change is mechanical. Same for
[`server/api/src/agent/summarizer.ts`](../server/api/src/agent/summarizer.ts) and
[`server/api/src/agent/reflector.ts`](../server/api/src/agent/reflector.ts), same
shape, same fix.

**3b. Tool loop refactor** (~400-500 LOC, the hard piece).
[`packages/runtime/src/agent/tool-loop.ts`](../packages/runtime/src/agent/tool-loop.ts)
currently calls `client.chat.send()` on the OpenRouter SDK, tightly
coupled to OR's response shape. Migrating means:

- The chat adapters need to expose tool-call info on `ChatResult`
  (today their `chat()` returns just `{text, model, tokensIn, tokensOut}`).
- Each provider serialises tool calls differently:
  Anthropic emits `tool_use` blocks inside `content[]`, OpenAI emits
  a `tool_calls` array on the message, Google emits `functionCall`
  on `parts[]`. Each adapter has to normalise to a single shape that
  `runToolLoop` can iterate.
- Streaming was previously deferred (see [the streaming feasibility
  conversation](https://github.com/crossworks-engineering/mantle/commits/main),
  search for "Assistant streaming"); not in scope for Phase 3 either.
  Keep one-shot calls for now.

**3c. Add `provider` column to `agents` table** (~100 LOC). New migration
(`0048_agents_provider.sql`), Drizzle schema update, agents-client.tsx
gets a provider dropdown. Same `RUNTIME_OR_ONLY_KINDS`-equivalent
mechanism the workers form uses, except inverted: now that the
runtime supports direct providers, the form unlocks the dropdown.

**3d. Unclamp the workers + agents forms** (~50 LOC). Remove the
`RUNTIME_OR_ONLY_KINDS` set in
[`jackdaw/app/(app)/settings/ai-workers/worker-form.tsx`](<../jackdaw/app/(app)/settings/ai-workers/worker-form.tsx>).
Remove the `service === 'openrouter'` filter in
[`jackdaw/app/(app)/settings/agents/agents-client.tsx`](<../jackdaw/app/(app)/settings/agents/agents-client.tsx>).
The KeyValidityHint and capability filters take over from there,
they already work for the other kinds.

**3e. Docs cleanup** (~30 LOC). Update §8.1 routing table to flip
chat-shaped + agents to "adapter registry, provider honoured". Remove
the "Stage 2 clamps" notes from §5e and the worker form. Update
[`docs/architecture.md`](./architecture.md) §16 (known sharp edges)
to retire the "production chat still routes through OpenRouter SDK
directly" entry.

#### Order of execution

Recommended sequence (each commit-sized, independently mergeable):

1. **3a first**: easiest, validates the chat adapter framework end-to-end
   against real production traffic without touching the tool loop.
   Single-turn chat is the unit test of the adapter; if Anthropic-direct
   works for the extractor, it'll work everywhere.
2. **3b next**: the tool loop refactor. Most of the engineering risk
   is here.
3. **3c then 3d together**: schema change + form unlock. Trivial after
   the runtime supports it.
4. **3e last**: docs cleanup once the migration is durable.

#### Risk surfaces a fresh session should look at carefully

- **Cache key sensitivity in tool-loop steps.** Anthropic's prompt
  caching (the `cache_control: { type: 'ephemeral' }` markers on the
  system block + digest block) is emitted by the OpenRouter SDK
  call. The chat adapters need to honour it too, `ChatOptions` should
  grow a `cacheControl?` option or the adapters should detect it from
  message metadata. Worth tracing through carefully because cache hits
  are the dominant cost-saving on the responder path.
- **Tool-call reassembly.** Streaming is out of scope (per the
  deferred streaming discussion), so this is simpler than it could
  be, but each provider's response format still differs. Anthropic's
  `tool_use` blocks have `input` as a parsed object; OpenAI's
  `tool_calls[].function.arguments` is a JSON string. The adapter
  layer has to normalise.
- **Usage capture.** `captureLlmUsage` reads `result.usage` to bill
  token counts to the trace. Every chat adapter needs to populate
  `ChatResult.tokensIn` / `tokensOut` consistently, the existing
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
