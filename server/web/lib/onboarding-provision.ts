import { db, agents, eq, and, isRefusedRight } from '@mantle/db';
import { findProviderKeyIds } from '@mantle/api-keys';
import {
  buildPersonaPrompt,
  DEFAULT_PERSONA_NAMES,
  loadProfilePreferences,
  type PersonaGender,
  type PersonaPresetKey,
} from '@mantle/content';
import { azureDeploymentName, WORKER_MODEL_KINDS } from '@mantle/client-types/model-choices';
import { updateAiWorker, listAiWorkers } from '@/lib/ai-workers';
import { createAgent, updateAgent } from '@/lib/agents';
// Workers, the persona's structure, and the specialist stack are all seeded from
// the declarative manifest — the single source of truth shared with the CLI
// `pnpm seed:*` scripts, the boot reconcile, and the integrity/config checker.
import {
  applyManifest,
  seedToolCapabilities,
  seedManifestWorkers,
  PERSONA_MANIFEST,
  PERSONA_SLUG,
  PERSONA_TOOL_GROUP_SLUGS,
} from '@/lib/system-manifest';
import type { ProvisionResult } from '@mantle/client-types';
import { attachDefaultAssistantsQuietly } from './workspaces-migrate';
export type { ProvisionResult };

/**
 * Onboarding provisioner — turns the API keys the user just entered into a
 * fully-working agent + AI-worker set. This is the user OVERLAY on the manifest
 * template: the keys decide which routes seed, the personality step decides the
 * persona's name/voice/preset; everything structural (worker models + routing,
 * the persona's model/params/budgets, the specialist stack) comes from the
 * manifest (MANIFEST_WORKERS / PERSONA_MANIFEST), seeded via seedManifestWorkers
 * + applyManifest.
 *
 *   OpenRouter (one required key) → the persona responder + the indexing/media
 *     workers, and — when no xAI key was added — voice too (tts + stt).
 *   xAI (optional) → upgrades voice (tts + stt) to the dedicated grok route.
 *   Embeddings → local EmbeddingGemma (no row, no key — resolved by default).
 *
 * Idempotent: a kind that already has a worker, or an agent slug that already
 * exists, is left alone — so re-running (back/forward in the wizard) never
 * duplicates. The persona is created with a sensible default here and refined
 * by the personality step via `savePersonaAgent`.
 */

// Worker models + routing now live in the manifest (MANIFEST_WORKERS), seeded
// via seedManifestWorkers. The one thing onboarding still owns is the user
// OVERLAY: which API keys exist (handled inside the seeder) and the persona's
// voice id, which follows the chosen gender.

/** Voice id per persona gender — xAI grok voices (the dedicated TTS route, and
 *  the same voices the production personas use): female `ara`, male `rex`. */
export function voiceForGender(gender: PersonaGender): string {
  return gender === 'female' ? 'ara' : 'rex';
}

export const PERSONA_AGENT_SLUG = PERSONA_SLUG;

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
    // A refused right (42501: a write the narrow login may not make off its
    // spot) is a bug to see, never a quiet empty stack.
    //
    if (isRefusedRight(err)) throw err;
    console.error('[onboarding] applyManifest failed:', err);
    return [];
  }
}

/** The key each service's pin names: the one an unpinned lookup would use
 *  ('default', else the oldest), so a pin never differs from it. */
async function keyIdByService(ownerId: string): Promise<Record<string, string>> {
  return Object.fromEntries(await findProviderKeyIds(ownerId));
}

/**
 * `opts.configuredBy`: the login provisioning (null for the anchor). On the
 * Azure route the provisioner pairs the vault's 'custom' key with the Azure
 * endpoint, so the route it writes records it as configured_by and resolves
 * the key at run time only while that login holds the keys area (W7
 * integration fix; the route handler refuses a provision of an Azure route
 * by a login without the keys area).
 */
export async function provisionDefaults(
  ownerId: string,
  opts: { configuredBy: string | null },
): Promise<ProvisionResult> {
  const keys = await keyIdByService(ownerId);
  const openrouter = keys['openrouter'] ?? null;

  // The Models-step overlay (assistant + worker model picks, optionally pinned
  // to an Azure OpenAI endpoint via the `custom` provider). The manifest stays
  // the structural template; these overrides are applied AFTER seeding, exactly
  // like the personality step's persona overlay.
  const prefs = await loadProfilePreferences(ownerId);
  const modelOverlay = prefs.onboardingModels;
  const customKey = keys['custom'] ?? null;
  const azureRoute = modelOverlay?.route === 'azure' && !!modelOverlay.azureBaseUrl && !!customKey;

  // Seed AI workers from the manifest (the single source for models/params +
  // the OpenRouter→xAI voice routing). Idempotent; skips kinds that need a key
  // the user didn't add. The tts default voice is the female preset; the
  // personality step retunes it per chosen gender (savePersonaAgent).
  const { created, skipped } = await seedManifestWorkers(ownerId);
  // The persona wires this worker's id for voice; re-read after seeding.
  const allWorkers = await listAiWorkers(ownerId);
  const ttsWorkerId = allWorkers.find((w) => w.kind === 'tts')?.id ?? null;

  // Models-step overlay: retarget the text-indexing workers to the user's fast
  // model (and, on the Azure route, to the custom provider + endpoint). Done
  // here rather than in the seeder so seedManifestWorkers stays manifest-pure.
  if (modelOverlay?.workerModel) {
    for (const w of allWorkers) {
      if (!(WORKER_MODEL_KINDS as readonly string[]).includes(w.kind)) continue;
      await updateAiWorker(
        ownerId,
        w.id,
        azureRoute
          ? {
              model: azureDeploymentName(modelOverlay.workerModel),
              provider: 'custom',
              baseUrl: modelOverlay.azureBaseUrl ?? null,
              apiKeyId: customKey,
              configuredBy: opts.configuredBy,
            }
          : { model: modelOverlay.workerModel },
      );
    }
  }

  // Seed the capability SUBSTRATE — the builtin tool ROWS *and* the tool GROUPS —
  // BEFORE the persona is created and granted its groups. P6 makes groups the
  // sole grant, so if the groups don't exist yet the persona's grant resolves to
  // 0 tools and it can't act. Seeding them first means the grant resolves
  // immediately and never dangles, even if the later specialist-stack seed fails.
  // applyManifest (in seedSpecialistStack) re-runs this idempotently.
  if (openrouter || azureRoute) {
    // It runs at the full-route spot tool-group-grant (seed.ts). A refusal
    // of the narrow login is a route bug, never a soft failure: it is thrown,
    // not logged and swallowed (plan v3.2 S7b part b2 round 8 B).
    await seedToolCapabilities(ownerId).catch((err) => {
      if (isRefusedRight(err)) throw err;
      console.error('[onboarding] seedToolCapabilities failed:', err);
    });
  }

  // The persona agent — created with the Warm/Saskia default; the personality
  // step refines name/voice/preset/temperature. role='responder' serves both
  // the web /assistant (which falls back responder→) and Telegram. It's seeded
  // with the full generalist tool grant so it can actually act from message one.
  let createdAgent: ProvisionResult['createdAgent'] = null;
  if (openrouter || azureRoute) {
    const [existingAgent] = await db
      .select({ id: agents.id, toolGroupSlugs: agents.toolGroupSlugs })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_AGENT_SLUG)))
      .limit(1);
    if (!existingAgent) {
      const name = DEFAULT_PERSONA_NAMES.female;
      // Structure comes from the manifest persona entry (model, params, context
      // budgets, tool groups) — the single template. The OVERLAY is the bits the
      // user chooses: the generated prompt (persona bank + personality step), the
      // name, and the tts worker. role='responder' serves both the web /assistant
      // (which falls back responder→) and Telegram.
      await createAgent(ownerId, {
        slug: PERSONA_SLUG,
        name,
        description: 'Your personal assistant.',
        role: PERSONA_MANIFEST.role,
        // Models-step overlay: the user's assistant pick (manifest default when
        // untouched); the Azure route pins provider `custom` + the endpoint.
        provider: azureRoute ? 'custom' : 'openrouter',
        model: azureRoute
          ? azureDeploymentName(modelOverlay?.assistantModel ?? PERSONA_MANIFEST.model)
          : (modelOverlay?.assistantModel ?? PERSONA_MANIFEST.model),
        apiKeyId: azureRoute ? customKey : openrouter,
        baseUrl: azureRoute ? (modelOverlay?.azureBaseUrl ?? null) : null,
        configuredBy: azureRoute ? opts.configuredBy : null,
        ttsWorkerId,
        // Name-agnostic: the prompt carries `{{name}}` and resolves from the
        // `name` set above, so renaming the persona later actually renames it.
        systemPrompt: buildPersonaPrompt('warm', { gender: 'female' }),
        toolGroupSlugs: [...PERSONA_TOOL_GROUP_SLUGS],
        memoryConfig: { ...(PERSONA_MANIFEST.memoryConfig ?? {}) },
        params: { ...PERSONA_MANIFEST.params },
        priority: PERSONA_MANIFEST.priority,
        enabled: true,
      });
      createdAgent = { slug: PERSONA_SLUG, name };
    } else if (!existingAgent.toolGroupSlugs || existingAgent.toolGroupSlugs.length === 0) {
      // Repair an assistant that was provisioned before grants existed (or
      // hand-created empty) — re-running the wizard restores the generalist
      // group grant. (P6: capability is groups, so an empty toolGroupSlugs is the
      // "toolless" signal, not empty tool_slugs.)
      await updateAgent(ownerId, existingAgent.id, {
        toolGroupSlugs: [...PERSONA_TOOL_GROUP_SLUGS],
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
  // The persona now exists: put it on Admin (a fresh install was migrated at
  // signup, before it existed; W5b1 M-new). A fresh install has no Team
  // workspace (0286), so the team responder stays on no workspace until an
  // Admin user attaches it to one. In the scope of the login provisioning
  // (the anchor's when configuredBy is null): the attach asks it the
  // assistants area (0307).
  await attachDefaultAssistantsQuietly('onboarding', opts.configuredBy ?? ownerId);

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
export async function savePersonaAgent(ownerId: string, input: SavePersonaInput): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_AGENT_SLUG)))
    .limit(1);
  if (!row) return false;

  const name = input.assistantName.trim() || DEFAULT_PERSONA_NAMES[input.gender];
  await updateAgent(ownerId, row.id, {
    name,
    systemPrompt: buildPersonaPrompt(input.presetKey, { gender: input.gender }),
    // temperature is the user's overlay; max_tokens stays the manifest default.
    params: { temperature: input.temperature, max_tokens: PERSONA_MANIFEST.params.max_tokens },
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
