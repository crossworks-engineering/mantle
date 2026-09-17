/**
 * The pool vocabulary for the /models curator: which curated lists exist and
 * what each is for. Served to the client by GET /api/model-pools (server-driven
 * on purpose — a new pool needs no contract-package release, same pattern as
 * KNOWN_KEY_SERVICES).
 *
 * `agents` is ONE shared pool: every conversational agent/specialist (assistant
 * through coder) picks from the same premium list. Each ai_worker kind gets its
 * own pool. `embedding` is deliberately absent — the 768-dim local singleton is
 * not switchable (docs/embeddings.md), so curating it would be a trap.
 */

export type ModelPoolDef = {
  id: string;
  label: string;
  /** What the pool's consumer does — shown to the curator and the picker. */
  description: string;
  /** Which side of the split it belongs to. */
  group: 'agents' | 'workers';
  /** What the pool's consumer needs the model to DO, in catalog terms. */
  modality: PoolModality;
};

/**
 * A pool's modality contract, expressed the way OpenRouter's catalog does
 * (`architecture.input_modalities` / `output_modalities`).
 *
 * This exists because of one specific trap: "Read images" and "Image
 * generation" BOTH accept image input, so the input side alone cannot tell
 * them apart. A generator like Nano Banana Pro (`google/gemini-3-pro-image`,
 * `text+image->text+image`) looks like a perfect vision model on inputs
 * alone, and a curator reading names picks it for the reader pool — where it
 * bills image-generation tokens and hands back a picture instead of the text
 * the vision worker parses. The OUTPUT side is the decider: an image READER
 * is just a capable text-out model that happens to accept pictures.
 */
export type PoolModality = {
  /** Modalities the model must ACCEPT. Empty = text-only is fine. */
  input: readonly ('image' | 'file')[];
  /** What the consumer reads back, in OpenRouter's own output_modalities
   *  vocabulary — `speech` is a TTS engine, `transcription` an ASR one. Those
   *  two used to be uncheckable (the catalog fetch was the text-out slice, so
   *  a voice route was always "unknown"); since the fetch asks for
   *  `output_modalities=all` they carry positive evidence like everything
   *  else. */
  output: 'text' | 'image' | 'speech' | 'transcription';
};

const TEXT_OUT: PoolModality = { input: [], output: 'text' };

export const MODEL_POOLS: readonly ModelPoolDef[] = [
  {
    id: 'agents',
    label: 'Agents / Responders',
    description:
      'The shared premium pool: the assistant persona, team responder, and every specialist (pages, tables, coder, appsmith, researcher…). Frontier chat models with strong tool use.',
    group: 'agents',
    modality: TEXT_OUT,
  },
  {
    id: 'extractor',
    label: 'Extractor',
    description:
      'Reads every ingested item and produces the summary, facts, and entities. Highest call volume in the system — needs cheap, fast, reliable structured output.',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'summarizer',
    label: 'Summarizer',
    description: 'Condenses text wherever a summary is needed. Cheap, fast workhorse.',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'reflector',
    label: 'Reflector',
    description: 'Periodic memory-reflection passes over recent activity. Cheap, fast workhorse.',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'document',
    label: 'Document reader',
    description:
      'Reads whole documents natively (PDF understanding). Needs a multimodal model that accepts document input.',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'vision',
    label: 'Read images',
    description: 'Pulls text and meaning out of images (uploads, extracted document images).',
    group: 'workers',
    modality: { input: ['image'], output: 'text' },
  },
  {
    id: 'image_gen',
    label: 'Image generation',
    description: 'Generates images. Provider-specific catalog (Gemini image, DALL-E, …).',
    group: 'workers',
    modality: { input: [], output: 'image' },
  },
  {
    id: 'tts',
    label: 'Assistant voice (TTS)',
    description:
      'Turns replies into speech. Provider-specific catalog (Grok voice, GPT-4o TTS voices, ElevenLabs).',
    group: 'workers',
    modality: { input: [], output: 'speech' },
  },
  {
    id: 'stt',
    label: 'Transcribe (STT)',
    description:
      'Speech to text for voice notes and video ingest (Whisper family, grok-stt, gpt-4o-mini-transcribe).',
    group: 'workers',
    modality: { input: [], output: 'transcription' },
  },
  {
    id: 'search',
    label: 'Web search',
    description:
      'The standard web-search answer tier. Must be a search-native model (Perplexity Sonar family).',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'search_advanced',
    label: 'Deep web search',
    description: 'The strong search tier for hard or conflicting questions (sonar-pro class).',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'narrator',
    label: 'Narrator',
    description:
      'Turns tool outcomes and events into short prose for the user. Off the critical path — cheap.',
    group: 'workers',
    modality: TEXT_OUT,
  },
  {
    id: 'suggester',
    label: 'Follow-up suggester',
    description:
      'Generates the follow-up suggestion chips after a reply. Cheapest of all; has a fallback chain (suggester → narrator → summarizer).',
    group: 'workers',
    modality: TEXT_OUT,
  },
];

export const MODEL_POOL_IDS = new Set(MODEL_POOLS.map((p) => p.id));

const POOL_BY_ID = new Map(MODEL_POOLS.map((p) => [p.id, p]));

/** One model's modalities as OpenRouter reports them. */
export type ModelModalities = {
  input: readonly string[];
  output: readonly string[];
};

/** The coarse bucket a catalog row falls into. `chat` is what a text-out row
 *  is called; the rest mirror OpenRouter's output-modality vocabulary. */
export type CatalogKind =
  'chat' | 'image' | 'video' | 'tts' | 'stt' | 'embedding' | 'rerank' | 'audio';

/**
 * Bucket a model by what it PRODUCES. Lives here, beside `poolModelIssue`, so
 * the /models type filter and the Curator's `model_catalog` filter cannot
 * drift apart — they are answering the same question off the same field, and
 * two copies of this ordering would eventually disagree about (say) a model
 * that both generates images and returns text.
 *
 * Order matters: the dedicated buckets win over the generic ones, and audio
 * beside text is a speech-capable CHAT model (`openai/gpt-audio`) rather than
 * a sound generator.
 */
export function kindFromModalities(output: readonly string[]): CatalogKind {
  if (output.includes('transcription')) return 'stt';
  if (output.includes('speech')) return 'tts';
  if (output.includes('embeddings')) return 'embedding';
  if (output.includes('rerank')) return 'rerank';
  if (output.includes('video')) return 'video';
  if (output.includes('image')) return 'image';
  if (output.includes('audio') && !output.includes('text')) return 'audio';
  return 'chat';
}

/**
 * Does this model belong in this pool? Returns the reason it does NOT, or
 * null when it fits.
 *
 * Fail-open by design (same rule as the worker-config catalog check): a
 * `null` modalities argument means the catalog never loaded, and an outage
 * must never block a curator from recording their judgment. Only positive
 * catalog evidence rejects — a route the catalog does not list (every
 * direct-provider voice slug: ElevenLabs, Deepgram, Gemini voices) still
 * arrives here as an empty pair and passes.
 */
export function poolModelIssue(
  poolId: string,
  modalities: ModelModalities | null | undefined,
): string | null {
  const pool = POOL_BY_ID.get(poolId);
  if (!pool || !modalities) return null;
  const want = pool.modality;
  const outputs = modalities.output ?? [];
  const inputs = modalities.input ?? [];
  if (outputs.length === 0 && inputs.length === 0) return null;

  const makesImages = outputs.includes('image');
  if (want.output === 'text' && makesImages) {
    return (
      `this model OUTPUTS images (${outputs.join('+')}) — it is an image generator, ` +
      `and the ${pool.label} pool needs a text-out model. Put it in the Image generation ` +
      `pool instead. Reading images is just a capable text-out model that accepts pictures.`
    );
  }
  // Everything else non-text on a text-out pool: video, speech (a TTS engine),
  // transcription (an ASR one), embeddings, rerank. Before the catalog was
  // widened these could not reach a text pool because the fetch never listed
  // them; now they can, so the guard has to name them.
  if (want.output === 'text' && !outputs.includes('text') && outputs.length > 0) {
    return `this model outputs ${outputs.join('+')}, not text — the ${pool.label} pool needs a text-out model.`;
  }
  if (want.output === 'image' && !makesImages && outputs.length > 0) {
    return `this model does not output images (${outputs.join('+')}) — the ${pool.label} pool needs a generator.`;
  }
  // Voice pools. Two shapes qualify for each: the dedicated engine
  // (`speech` / `transcription`) and the speech-capable chat model
  // (`openai/gpt-audio` is `text+audio->text+audio` and legitimately serves
  // BOTH pools — it is in the shipped template for both). What that still
  // catches is the classic swap: a pure TTS engine parked in Transcribe emits
  // no text and takes no audio, which is a positive contradiction.
  if (want.output === 'speech' && outputs.length > 0) {
    if (!outputs.includes('speech') && !outputs.includes('audio')) {
      return `this model outputs ${outputs.join('+')} — it produces no audio, and the ${pool.label} pool needs a model that speaks.`;
    }
  }
  if (want.output === 'transcription' && outputs.length > 0) {
    const transcribes =
      outputs.includes('transcription') || (outputs.includes('text') && inputs.includes('audio'));
    if (!transcribes) {
      return `this model does not turn audio into text (${inputs.join('+') || '?'}->${outputs.join('+')}) — the ${pool.label} pool needs one that does.`;
    }
  }
  for (const need of want.input) {
    if (inputs.length > 0 && !inputs.includes(need)) {
      return `this model does not accept ${need} input (accepts ${inputs.join('+')}) — the ${pool.label} pool needs one that does.`;
    }
  }
  return null;
}
