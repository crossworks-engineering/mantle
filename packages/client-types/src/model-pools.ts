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
  /** What the consumer reads back. `audio` pools live in the provider voice
   *  catalogs, not OpenRouter's chat catalog, so they are never checked. */
  output: 'text' | 'image' | 'audio';
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
    modality: { input: [], output: 'audio' },
  },
  {
    id: 'stt',
    label: 'Transcribe (STT)',
    description:
      'Speech to text for voice notes and video ingest (Whisper family, grok-stt, gpt-4o-mini-transcribe).',
    group: 'workers',
    modality: { input: [], output: 'audio' },
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

/**
 * Does this model belong in this pool? Returns the reason it does NOT, or
 * null when it fits.
 *
 * Fail-open by design (same rule as the worker-config catalog check): a
 * `null` modalities argument means the catalog never loaded, and an outage
 * must never block a curator from recording their judgment. Only positive
 * catalog evidence rejects. Audio pools (tts/stt) are never checked — their
 * models live in the provider voice catalogs, not OpenRouter's chat catalog,
 * so any "evidence" about them here would be an absence, not a fact.
 */
export function poolModelIssue(
  poolId: string,
  modalities: ModelModalities | null | undefined,
): string | null {
  const pool = POOL_BY_ID.get(poolId);
  if (!pool || !modalities) return null;
  const want = pool.modality;
  if (want.output === 'audio') return null;
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
  if (want.output === 'image' && !makesImages && outputs.length > 0) {
    return `this model does not output images (${outputs.join('+')}) — the ${pool.label} pool needs a generator.`;
  }
  for (const need of want.input) {
    if (inputs.length > 0 && !inputs.includes(need)) {
      return `this model does not accept ${need} input (accepts ${inputs.join('+')}) — the ${pool.label} pool needs one that does.`;
    }
  }
  return null;
}
