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
};

export const MODEL_POOLS: readonly ModelPoolDef[] = [
  {
    id: 'agents',
    label: 'Agents / Responders',
    description:
      'The shared premium pool: the assistant persona, team responder, and every specialist (pages, tables, coder, appsmith, researcher…). Frontier chat models with strong tool use.',
    group: 'agents',
  },
  {
    id: 'extractor',
    label: 'Extractor',
    description:
      'Reads every ingested item and produces the summary, facts, and entities. Highest call volume in the system — needs cheap, fast, reliable structured output.',
    group: 'workers',
  },
  {
    id: 'summarizer',
    label: 'Summarizer',
    description: 'Condenses text wherever a summary is needed. Cheap, fast workhorse.',
    group: 'workers',
  },
  {
    id: 'reflector',
    label: 'Reflector',
    description: 'Periodic memory-reflection passes over recent activity. Cheap, fast workhorse.',
    group: 'workers',
  },
  {
    id: 'document',
    label: 'Document reader',
    description:
      'Reads whole documents natively (PDF understanding). Needs a multimodal model that accepts document input.',
    group: 'workers',
  },
  {
    id: 'vision',
    label: 'Read images',
    description: 'Pulls text and meaning out of images (uploads, extracted document images).',
    group: 'workers',
  },
  {
    id: 'image_gen',
    label: 'Image generation',
    description: 'Generates images. Provider-specific catalog (Gemini image, DALL-E, …).',
    group: 'workers',
  },
  {
    id: 'tts',
    label: 'Assistant voice (TTS)',
    description:
      'Turns replies into speech. Provider-specific catalog (Grok voice, GPT-4o TTS voices, ElevenLabs).',
    group: 'workers',
  },
  {
    id: 'stt',
    label: 'Transcribe (STT)',
    description:
      'Speech to text for voice notes and video ingest (Whisper family, grok-stt, gpt-4o-mini-transcribe).',
    group: 'workers',
  },
  {
    id: 'search',
    label: 'Web search',
    description:
      'The standard web-search answer tier. Must be a search-native model (Perplexity Sonar family).',
    group: 'workers',
  },
  {
    id: 'search_advanced',
    label: 'Deep web search',
    description: 'The strong search tier for hard or conflicting questions (sonar-pro class).',
    group: 'workers',
  },
  {
    id: 'narrator',
    label: 'Narrator',
    description:
      'Turns tool outcomes and events into short prose for the user. Off the critical path — cheap.',
    group: 'workers',
  },
  {
    id: 'suggester',
    label: 'Follow-up suggester',
    description:
      'Generates the follow-up suggestion chips after a reply. Cheapest of all; has a fallback chain (suggester → narrator → summarizer).',
    group: 'workers',
  },
];

export const MODEL_POOL_IDS = new Set(MODEL_POOLS.map((p) => p.id));
