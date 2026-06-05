import { db, agents, eq, and } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { seedBuiltinTools, DEFAULT_ASSISTANT_TOOL_SLUGS } from '@mantle/tools';
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
// The specialist stack (skills + Pages/Ledger/Remy/Researcher/Coder + their
// delegation wiring) is seeded from the declarative manifest — the single source
// of truth shared with the CLI `pnpm seed:*` scripts and the integrity checker.
import { applyManifest, deriveGroupGrants } from '@/lib/system-manifest';

/**
 * Onboarding provisioner — turns the API keys the user just entered into a
 * fully-working agent + AI-worker set. A single OpenRouter key powers everything:
 *
 *   OpenRouter (one required key) → the persona responder + extractor /
 *     summarizer / reflector / document / vision / image_gen, and — when no xAI
 *     key was added — voice too (tts + stt). `gemini-3.1-flash-lite` is the cheap
 *     multimodal workhorse behind most of it (verified affordable on one key).
 *   xAI (optional) → upgrades voice (tts + stt) to the dedicated grok route.
 *   Embeddings → local EmbeddingGemma (no row, no key — resolved by default).
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
// All OpenRouter-routed defaults below are the exact models verified working +
// affordable on a single OpenRouter key (operator-tested 2026-06). gemini-3.1-
// flash-lite is multimodal, so it backs extractor/summarizer/reflector AND
// document + vision — one cheap model for most of the brain.
const WORKER_MODEL = 'google/gemini-3.1-flash-lite'; // extractor / summarizer / reflector (OpenRouter)
const DOCUMENT_MODEL = 'google/gemini-3.1-flash-lite'; // PDF/document reader (OpenRouter)
const VISION_MODEL = 'google/gemini-3.1-flash-lite'; // image-reading (OpenRouter)
const ASSISTANT_MODEL = 'anthropic/claude-sonnet-4.6'; // the persona responder (OpenRouter)
const IMAGE_GEN_MODEL = 'google/gemini-3.1-flash-image-preview'; // image generation (OpenRouter)
const XAI_TTS_MODEL = 'grok-voice-latest'; // spoken replies (dedicated xAI key)
const XAI_STT_MODEL = 'grok-stt'; // voice-note transcription (dedicated xAI key)
const OR_TTS_MODEL = 'x-ai/grok-voice-tts-1.0'; // voice on the OpenRouter key
const OR_STT_MODEL = 'openai/gpt-4o-mini-transcribe'; // transcription on the OpenRouter key

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
  /** Specialist agents seeded alongside the persona (Pages, Ledger, Remy,
   *  Researcher, Coder) and wired into the assistant's delegate_to. Names of the
   *  ones that seeded successfully; a seed that throws is logged + omitted (it
   *  never aborts onboarding — the persona is what matters). */
  seededSpecialists: string[];
};

/**
 * Seed the specialist stack a fresh brain needs for delegation + the editor
 * Assist panels — skills, the Pages/Ledger/Remy/Researcher/Coder agents, their
 * delegation wiring, and the persona's behaviour skills. All from the declarative
 * manifest (the single source of truth) via `applyManifest`. Idempotent +
 * gap-fill (re-running the wizard never clobbers operator customisations).
 * Returns the seeded specialist names; never throws out — a failure is logged so
 * the persona (what matters) still completes onboarding.
 */
async function seedSpecialistStack(ownerId: string): Promise<string[]> {
  try {
    const { seededAgents } = await applyManifest(ownerId);
    return seededAgents;
  } catch (err) {
    console.error('[onboarding] applyManifest failed:', err);
    return [];
  }
}

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

  // Make sure the builtin tool ROWS exist for this owner before the assistant
  // (which references them by slug) is created — an agent with tool slugs that
  // resolve to no row simply can't call those tools. seedSpecialistStack reseeds
  // too; this guarantees it even if the stack is skipped/fails.
  if (openrouter) {
    await seedBuiltinTools(ownerId).catch((err) =>
      console.error('[onboarding] seedBuiltinTools failed:', err),
    );
  }

  // The persona agent — created with the Warm/Saskia default; the personality
  // step refines name/voice/preset/temperature. role='responder' serves both
  // the web /assistant (which falls back responder→) and Telegram. It's seeded
  // with the full generalist tool grant so it can actually act from message one.
  let createdAgent: ProvisionResult['createdAgent'] = null;
  if (openrouter) {
    const [existingAgent] = await db
      .select({ id: agents.id, toolSlugs: agents.toolSlugs })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_AGENT_SLUG)))
      .limit(1);
    if (!existingAgent) {
      const name = DEFAULT_PERSONA_NAMES.female;
      // The generalist grant, seeded DECOMPOSED into tool groups + a residual (P3)
      // so a fresh persona is already "broken up". Page/table authoring is excluded
      // by the deny-set (DEFAULT_ASSISTANT) — that work is delegated to the Pages /
      // Ledger specialists (P5); the persona reaches them via invoke_agent.
      const personaGrant = deriveGroupGrants([...DEFAULT_ASSISTANT_TOOL_SLUGS]);
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
        toolSlugs: personaGrant.toolSlugs,
        toolGroupSlugs: personaGrant.toolGroupSlugs,
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
    } else if (!existingAgent.toolSlugs || existingAgent.toolSlugs.length === 0) {
      // Repair an assistant that was provisioned before tools were granted (or
      // hand-created empty) — re-running the wizard fixes a toolless assistant.
      await updateAgent(ownerId, existingAgent.id, {
        toolSlugs: [...DEFAULT_ASSISTANT_TOOL_SLUGS],
      });
    }
  }

  // Seed the specialist stack (skills + Pages/Ledger/Remy/Researcher/Coder +
  // delegation wiring + the persona's behaviour skills) from the manifest. Needs
  // the OpenRouter key and the persona to already exist as the delegation entry
  // point. Idempotent + gap-fill, so re-running the wizard is safe.
  let seededSpecialists: string[] = [];
  if (openrouter) {
    seededSpecialists = await seedSpecialistStack(ownerId);
  }

  return { createdWorkers: created, createdAgent, skipped, seededSpecialists };
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
