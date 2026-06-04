import { db, agents, eq, and } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import {
  buildPersonaPrompt,
  DEFAULT_PERSONA_NAMES,
  type PersonaGender,
  type PersonaPresetKey,
} from '@mantle/content';
import {
  createAiWorker,
  updateAiWorker,
  listAiWorkers,
  type CreateAiWorkerInput,
} from '@/lib/ai-workers';
import { createAgent, updateAgent } from '@/lib/agents';

/**
 * Onboarding provisioner — turns the API keys the user just entered into a
 * fully-working agent + AI-worker set, mirroring the production configuration:
 *
 *   OpenRouter → chat (the persona responder) + extractor/summarizer/reflector
 *                /document workers (cheap gemini-flash-lite, grok for docs)
 *   xAI/Grok   → tts (voice) + image_gen          (only if a key was added)
 *   OpenAI     → stt (whisper-1) + vision (gpt-4o-mini)  (only if a key was added)
 *   Embeddings → local EmbeddingGemma (no row, no key — resolved by default)
 *
 * Idempotent: a kind that already has a worker, or an agent slug that already
 * exists, is left alone — so re-running (back/forward in the wizard) never
 * duplicates. The persona is created with a sensible default here and refined
 * by the personality step via `savePersonaAgent`.
 */

// Hybrid routing: OpenRouter is the one required key and covers chat, the
// indexing workers, image-reading (vision), and image generation — all solid on
// it. VOICE (tts/stt) is the one place the aggregator is weak, so it runs on a
// dedicated xAI key when the user adds one (grok voices ara/rex — the proven
// path the production personas use). Embeddings stay local.
const WORKER_MODEL = 'google/gemini-3.1-flash-lite'; // extractor / summarizer / reflector (OpenRouter)
const DOCUMENT_MODEL = 'x-ai/grok-4.3'; // PDF/document reader (OpenRouter)
const ASSISTANT_MODEL = 'anthropic/claude-sonnet-4.6'; // the persona responder (OpenRouter)
const VISION_MODEL = 'openai/gpt-4o-mini'; // image-reading (OpenRouter)
const IMAGE_GEN_MODEL = 'google/gemini-3.1-flash-image-preview'; // image generation (OpenRouter)
const XAI_TTS_MODEL = 'grok-voice-latest'; // spoken replies (dedicated xAI key)
const XAI_STT_MODEL = 'grok-stt'; // voice-note transcription (dedicated xAI key)
const OR_TTS_MODEL = 'x-ai/grok-voice-tts-1.0'; // voice fallback on the OpenRouter key
const OR_STT_MODEL = 'openai/whisper-large-v3'; // transcription fallback on the OpenRouter key

/** Voice id per persona gender — xAI grok voices (the dedicated TTS route, and
 *  the same voices the production personas use): female `ara`, male `rex`. */
export function voiceForGender(gender: PersonaGender): string {
  return gender === 'female' ? 'ara' : 'rex';
}

export const PERSONA_AGENT_SLUG = 'assistant';

export type ProvisionResult = {
  createdWorkers: { kind: string; name: string; provider: string; model: string }[];
  createdAgent: { slug: string; name: string } | null;
  /** Capabilities skipped because the optional key wasn't provided. */
  skipped: string[];
};

async function keyIdByService(ownerId: string): Promise<Record<string, string>> {
  const keys = await listApiKeys(ownerId);
  const map: Record<string, string> = {};
  // Prefer the 'default' label; fall back to the first of each service.
  for (const k of keys) {
    if (!(k.service in map) || k.label === 'default') map[k.service] = k.id;
  }
  return map;
}

export async function provisionDefaults(ownerId: string): Promise<ProvisionResult> {
  const keys = await keyIdByService(ownerId);
  const openrouter = keys['openrouter'] ?? null;
  const xai = keys['xai'] ?? null;

  const existing = await listAiWorkers(ownerId);
  const haveKind = new Set(existing.map((w) => w.kind));
  // Track the tts worker id (pre-existing or created this run) so the agent can
  // wire its voice without a second listAiWorkers round-trip.
  let ttsWorkerId: string | null = existing.find((w) => w.kind === 'tts')?.id ?? null;

  const created: ProvisionResult['createdWorkers'] = [];
  const skipped: string[] = [];

  // Helper: create one default worker for a kind, unless one already exists.
  // Returns the created worker, or null if a worker of that kind already existed.
  async function ensureWorker(input: CreateAiWorkerInput) {
    if (haveKind.has(input.kind)) return null;
    const worker = await createAiWorker({ ...input, enabled: true, isDefault: true });
    created.push({
      kind: input.kind,
      name: input.name,
      provider: input.provider,
      model: input.model,
    });
    haveKind.add(input.kind);
    return worker;
  }

  if (!openrouter) {
    // OpenRouter is the backbone — without it nothing chat-shaped can run.
    skipped.push('chat + indexing workers (no OpenRouter key)');
  } else {
    await ensureWorker({
      ownerId, kind: 'extractor', name: 'Extractor', provider: 'openrouter',
      model: WORKER_MODEL, apiKeyId: openrouter, params: { extract_facts: true },
    });
    await ensureWorker({
      ownerId, kind: 'summarizer', name: 'Summarizer', provider: 'openrouter',
      model: WORKER_MODEL, apiKeyId: openrouter,
    });
    await ensureWorker({
      ownerId, kind: 'reflector', name: 'Reflector', provider: 'openrouter',
      model: WORKER_MODEL, apiKeyId: openrouter,
    });
    await ensureWorker({
      ownerId, kind: 'document', name: 'Document reader', provider: 'openrouter',
      model: DOCUMENT_MODEL, apiKeyId: openrouter,
    });
    // Image reading (vision) + image generation also ride the OpenRouter key —
    // both work well on it, and cost nothing until actually used.
    await ensureWorker({
      ownerId, kind: 'vision', name: 'Read images', provider: 'openrouter',
      model: VISION_MODEL, apiKeyId: openrouter,
    });
    await ensureWorker({
      ownerId, kind: 'image_gen', name: 'Image generation', provider: 'openrouter',
      model: IMAGE_GEN_MODEL, apiKeyId: openrouter,
    });
  }

  // Voice (spoken replies + voice-note transcription). Prefer a dedicated xAI
  // key when the user added one (the smoother, proven path, grok voices ara/rex).
  // Otherwise fall back to the OpenRouter key (grok-voice-tts-1.0 / whisper) so
  // voice still works out of the box on a single key.
  if (xai) {
    const tts = await ensureWorker({
      ownerId, kind: 'tts', name: 'Assistant voice', provider: 'xai',
      model: XAI_TTS_MODEL, apiKeyId: xai,
      params: { voice: voiceForGender('female'), format: 'mp3' },
    });
    if (tts) ttsWorkerId = tts.id;
    await ensureWorker({
      ownerId, kind: 'stt', name: 'Transcribe voice', provider: 'xai',
      model: XAI_STT_MODEL, apiKeyId: xai, params: { language: 'en' },
    });
  } else if (openrouter) {
    const tts = await ensureWorker({
      ownerId, kind: 'tts', name: 'Assistant voice', provider: 'openrouter',
      model: OR_TTS_MODEL, apiKeyId: openrouter,
      params: { voice: voiceForGender('female'), format: 'mp3' },
    });
    if (tts) ttsWorkerId = tts.id;
    await ensureWorker({
      ownerId, kind: 'stt', name: 'Transcribe voice', provider: 'openrouter',
      model: OR_STT_MODEL, apiKeyId: openrouter, params: { language: 'en' },
    });
  }

  // The persona agent — created with the Warm/Saskia default; the personality
  // step refines name/voice/preset/temperature. role='responder' serves both
  // the web /assistant (which falls back responder→) and Telegram.
  let createdAgent: ProvisionResult['createdAgent'] = null;
  if (openrouter) {
    const [existingAgent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_AGENT_SLUG)))
      .limit(1);
    if (!existingAgent) {
      const name = DEFAULT_PERSONA_NAMES.female;
      await createAgent(ownerId, {
        slug: PERSONA_AGENT_SLUG,
        name,
        description: 'Your personal assistant.',
        role: 'responder',
        provider: 'openrouter',
        model: ASSISTANT_MODEL,
        apiKeyId: openrouter,
        ttsWorkerId,
        systemPrompt: buildPersonaPrompt('warm', { assistantName: name, gender: 'female' }),
        memoryConfig: {
          history_limit: 20,
          digest_limit: 3,
          fact_limit: 10,
          content_hit_limit: 5,
          inject_lifelog: true,
          delegate_to: [],
        },
        params: { temperature: 0.7, max_tokens: 16000 },
        priority: 100,
        enabled: true,
      });
      createdAgent = { slug: PERSONA_AGENT_SLUG, name };
    }
  }

  return { createdWorkers: created, createdAgent, skipped };
}

export type SavePersonaInput = {
  presetKey: PersonaPresetKey;
  assistantName: string;
  gender: PersonaGender;
  temperature: number;
};

/**
 * Apply the personality step to the persona agent: rebuild the system prompt
 * from the chosen preset, set the name + temperature, and point the TTS worker
 * at the voice that matches the chosen gender. Returns false if the agent
 * doesn't exist (no OpenRouter key was provided).
 */
export async function savePersonaAgent(
  ownerId: string,
  input: SavePersonaInput,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_AGENT_SLUG)))
    .limit(1);
  if (!row) return false;

  const name = input.assistantName.trim() || DEFAULT_PERSONA_NAMES[input.gender];
  await updateAgent(ownerId, row.id, {
    name,
    systemPrompt: buildPersonaPrompt(input.presetKey, { assistantName: name, gender: input.gender }),
    params: { temperature: input.temperature, max_tokens: 16000 },
  });

  // Retune the voice to match the gender (the worker was created female-default).
  const ttsWorker = (await listAiWorkers(ownerId)).find((w) => w.kind === 'tts');
  if (ttsWorker) {
    await updateAiWorker(ownerId, ttsWorker.id, {
      params: { voice: voiceForGender(input.gender), format: 'mp3' },
    });
  }
  return true;
}
