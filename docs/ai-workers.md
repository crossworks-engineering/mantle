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
  embedding_model?: string
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
```

The runtime looks up `getChatAdapter(worker.provider)` /
`getTtsAdapter(worker.provider)` / etc. and calls the right interface.

`isProviderWired(providerId, capability)` reports whether an adapter
is registered for that combination — drives the "not yet wired" hint
in the UI dropdown.

### 3.3 Currently shipped adapters

| Provider | Chat | TTS | STT | Vision | Image-gen |
|---|---|---|---|---|---|
| OpenRouter | ✅ (direct SDK, not via registry) | — | — | — | — |
| OpenAI | (via OpenRouter) | ✅ openai-tts | ✅ openai-stt | ✅ openai-vision | ✅ openai-image (gpt-image-1 / DALL-E 3 / DALL-E 2) |
| xAI (Grok) | ✅ xai-chat | ✅ xai-tts | ✅ xai-stt | ✅ xai-vision | ✅ xai-image (grok-imagine-image) |
| Hugging Face | ✅ huggingface-chat | — | — | — | ✅ huggingface-image (FLUX-1, SDXL, SD 3.5) |
| Anthropic (direct) | ✅ anthropic-chat | — | — | ✅ anthropic-vision | — *(provider doesn't ship image-gen)* |
| Google (Gemini) | ✅ google-chat | ✅ google-tts | ✅ google-stt (via generateContent) | ✅ google-vision | ✅ google-image (Imagen 3 / 4) |
| ElevenLabs | — | ✅ elevenlabs-tts | ✅ elevenlabs-stt (Scribe v1) | — | — |
| Deepgram | — | — | ✅ deepgram-stt | — | — |
| AssemblyAI | — | — | ✅ assemblyai-stt | — | — |

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

---

## 5b. Attachment ingestion (images + documents)

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

The production chat path used by the responder, the web `/assistant`,
and the existing reflector/extractor/summarizer **still goes through
the OpenRouter SDK directly**, not via the chat adapter registry. The
adapter framework is exercised by:

- New workers explicitly configured for xAI / HF / Anthropic / Google
- The "Test chat" button on chat-shaped workers
- Future migrations to non-OpenRouter providers

This is deliberate. The OpenRouter path is well-tested, supports the
tool-loop, has cost accounting wired, and aggregates ~50 chat models
already. Migrating it to the adapter registry is a non-breaking
refactor we'd do if/when there's a real reason (cost arbitrage,
provider failover, capabilities OpenRouter doesn't expose). The
adapter framework is the boundary; flipping the responder to use it
is a one-day change.

**Update (May 2026):** Vision and image-gen adapters are now live —
see §3.3 for the matrix. Vision plugs into both Telegram photo ingest
(automatic) and Saskia's `extract_from_image` tool (on-demand).
Image-gen plugs into Saskia's `generate_image` tool. Both are wired
for OpenAI, xAI, Google, and (image-gen only) Hugging Face.
Anthropic ships vision but no image generation.

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
   - Vision / image-gen — config saved but dispatch not yet wired.

Each worker has its own model, API key, params. Multiple workers per
kind are allowed (priority + is_default flag picks the winner).

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

---

## 10. Future shape

Open questions and likely next moves:

- **Vision adapter for whiteboard ingestion.** Image attachments
  arrive → vision adapter extracts markdown → ingested as a note.
  OpenAI / Anthropic / Google all do this; pick one as the first
  built-in.
- **Image-gen tool for the responder.** Tool wrapper on top of an
  image-gen adapter so Saskia can generate diagrams / illustrations
  when asked.
- **Migrating the production chat path** to the registry. Lets us
  failover from OpenRouter → direct providers if OR has an outage,
  and unlocks cost-arbitrage logic (use cheapest provider for a
  given model family).
- **Embedding adapter interface.** Embeddings currently flow through
  `@mantle/embeddings` directly to OpenRouter; pulling them into the
  adapter layer would let workers configure their own embedding model
  (Cohere, Voyage, etc.) per use case.
- **Provider-aware cost tracking.** Each adapter knows the price of
  the call it made; surfacing per-provider spend in `/debug` would
  make cost-conscious provider choice obvious.
