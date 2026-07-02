import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  loadProfilePreferences,
  updateProfilePreferences,
  isPurposeArchetype,
} from '@mantle/content';
import { setApiKey, listApiKeys } from '@mantle/api-keys';
import {
  resolveEmbeddingConfig,
  probeEmbeddingRoute,
  DEFAULT_ONLINE_EMBEDDING_MODEL,
  DEFAULT_ONLINE_EMBEDDING_PROVIDER,
} from '@mantle/embeddings';
import { upsertEmbeddingConfig } from '@/lib/embedding-config';
import {
  ASSISTANT_MODEL_CHOICES,
  WORKER_MODEL_CHOICES,
} from '@/lib/system-manifest/model-choices';
import { getOwnerOr401 } from '@/lib/auth';
import { probeApiKey } from '@/lib/api-key-test';
import {
  provisionDefaults,
  savePersonaAgent,
  PERSONA_AGENT_SLUG,
} from '@/lib/onboarding-provision';
import { checkSystemIntegrity } from '@/lib/system-manifest';
import { isOnboarded, markOnboarded } from '@/lib/onboarding';
import { listAiWorkers } from '@/lib/ai-workers';
import { getAgentBySlug } from '@/lib/agents';

export const dynamic = 'force-dynamic';

/**
 * Onboarding wizard backend — the first-run flow's reads (GET) + every step's
 * mutation (POST, dispatched by `action`). Each step persists immediately
 * through existing primitives (keys, workers, agents, journal entries, preferences)
 * so a refresh resumes from `preferences.onboardingStep`. Consolidated to one
 * route because it's a single internal flow (replaces app/onboarding/actions.ts).
 */

export type SanityCheck = { label: string; ok: boolean; detail: string };
/** Mirror of identity-context's MAX_PURPOSE_CHARS — trim at the edge so the
 *  stored value never exceeds what the injected block would render anyway. */
const MAX_PURPOSE_CHARS = 600;

// The only onboarding action that took an unchecked `body as SavePersonaInput`
// cast — and savePersonaAgent does `input.assistantName.trim()` with no guard,
// so a malformed body 500'd. Validate it (enums mirror PersonaPresetKey /
// PersonaGender in @mantle/content; assistantName may be blank — the lib falls
// back to a default — so no `.min`). zod strips the extra `action` field.
const PersonaInput = z.object({
  presetKey: z.enum(['warm', 'professional', 'playful', 'concise']),
  assistantName: z.string(),
  gender: z.enum(['female', 'male']),
  temperature: z.number(),
});

/** Resume state for the wizard + the already-onboarded flag (the client honours
 *  ?force to re-run on a populated stack) + the provisioned assistant agent id. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [prefs, keys, onboarded, assistantAgent] = await Promise.all([
    loadProfilePreferences(user.id),
    listApiKeys(user.id),
    isOnboarded(user.id),
    getAgentBySlug(user.id, PERSONA_AGENT_SLUG),
  ]);
  return NextResponse.json({
    onboarded,
    step: prefs.onboardingStep ?? 'profile',
    timezone: prefs.timezone,
    locale: prefs.locale,
    savedServices: [...new Set(keys.map((k) => k.service))],
    assistantAgentId: assistantAgent?.id ?? null,
  });
}

async function runSanityChecks(userId: string): Promise<SanityCheck[]> {
  const checks: SanityCheck[] = [];
  const keys = await listApiKeys(userId);
  const byService = new Map(keys.map((k) => [k.service, k] as const));

  const orKey = byService.get('openrouter');
  if (orKey) {
    const t = await probeApiKey(orKey.id, 'openrouter');
    checks.push({ label: 'OpenRouter (chat, images)', ok: t.ok, detail: t.message });
  }
  const xaiKey = byService.get('xai');
  if (xaiKey) {
    const t = await probeApiKey(xaiKey.id, 'xai');
    checks.push({ label: 'xAI (voice: speak + transcribe)', ok: t.ok, detail: t.message });
  }

  try {
    const cfg = await resolveEmbeddingConfig(userId);
    const dim = await probeEmbeddingRoute(userId, {
      provider: cfg.primary.provider,
      model: cfg.model,
      baseUrl: cfg.primary.baseUrl,
      apiKeyId: cfg.primary.apiKeyId,
    });
    checks.push({
      label: 'Embeddings (memory search)',
      ok: dim === cfg.dimensions,
      detail: `${cfg.primary.provider} · ${cfg.model} · ${dim}-dim`,
    });
  } catch (err) {
    checks.push({
      label: 'Embeddings (memory search)',
      ok: false,
      detail:
        (err instanceof Error ? err.message : 'probe failed') +
        ' — local embedder may not be running yet; memory search will work once it is.',
    });
  }

  const agent = await getAgentBySlug(userId, PERSONA_AGENT_SLUG);
  checks.push({
    label: 'Your assistant',
    ok: Boolean(agent?.enabled),
    detail: agent ? `${agent.name} is ready` : 'no assistant agent — add an OpenRouter key',
  });

  const integrity = await checkSystemIntegrity(userId);
  for (const c of integrity.checks) {
    checks.push({
      label: c.label,
      ok: c.ok,
      detail:
        c.ok || !c.samples?.length
          ? c.detail
          : `${c.detail} — ${c.samples.map((s) => s.detail).join('; ')}`,
    });
  }

  const workers = await listAiWorkers(userId);
  const av = workers.filter((w) => ['tts', 'stt', 'vision', 'image_gen'].includes(w.kind));
  if (av.length > 0) {
    checks.push({
      label: 'Voice & images',
      ok: true,
      detail: `${av.length} capabilities on OpenRouter (speak, transcribe, read, generate)`,
    });
  }
  return checks;
}

async function savePurpose(
  userId: string,
  archetype: string,
  purpose: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = (purpose ?? '').trim();
  if (!p) {
    return { ok: false, error: 'Describe what this brain is for.' };
  }
  // Unknown/blank archetype falls back to 'custom' — the description is the
  // load-bearing field; the archetype is a (validated) hint.
  const key = isPurposeArchetype(archetype) ? archetype : 'custom';
  try {
    await updateProfilePreferences(userId, {
      purpose: p.slice(0, MAX_PURPOSE_CHARS),
      purposeArchetype: key,
      onboardingStep: 'personality',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save.' };
  }
}

/** Step dispatcher. Body is `{ action, ...payload }`. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;

  switch (action) {
    case 'step': {
      await updateProfilePreferences(user.id, { onboardingStep: String(body.step ?? '') });
      return NextResponse.json({ ok: true });
    }
    case 'profile': {
      try {
        // Optional "Your name" — what the assistant should call the operator
        // (replaces the old interview's name questions). Stored verbatim.
        const displayName = String(body.displayName ?? '').trim();
        await updateProfilePreferences(user.id, {
          timezone: String(body.timezone ?? ''),
          locale: String(body.locale ?? ''),
          ...(displayName ? { displayName } : {}),
          onboardingStep: 'openrouter',
        });
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Could not save.' });
      }
    }
    case 'saveKey': {
      const service = String(body.service ?? '');
      const trimmed = String(body.plaintext ?? '').trim();
      if (!trimmed) {
        return NextResponse.json({
          saved: false,
          test: { ok: false, message: 'Paste a key first.', provider: service, adapter: '' },
        });
      }
      const row = await setApiKey(user.id, service, 'default', trimmed);
      const test = await probeApiKey(row.id, service);
      return NextResponse.json({ saved: true, test });
    }
    case 'models': {
      // Onboarding's Models step. Stores the user's assistant + worker model
      // picks (validated against the curated lists) as the `onboardingModels`
      // pref; provisionDefaults() applies them as operator overlay on top of
      // the manifest seed. Route 'azure' additionally saves the Azure OpenAI
      // key under service 'custom' and live-probes `{baseUrl}/models` before
      // accepting the endpoint.
      const assistantModel = ASSISTANT_MODEL_CHOICES.find((m) => m.id === body.assistantModel)?.id;
      const workerModel = WORKER_MODEL_CHOICES.find((m) => m.id === body.workerModel)?.id;
      const route = body.route === 'azure' ? 'azure' : 'openrouter';
      if (!assistantModel || !workerModel) {
        return NextResponse.json({ ok: false, message: 'Pick an assistant model and a worker model.' });
      }
      if (route === 'azure') {
        const aOk = ASSISTANT_MODEL_CHOICES.find((m) => m.id === assistantModel)?.azure === true;
        const wOk = WORKER_MODEL_CHOICES.find((m) => m.id === workerModel)?.azure === true;
        if (!aOk || !wOk) {
          return NextResponse.json({ ok: false, message: 'On Azure, pick OpenAI-family models (marked Azure-capable).' });
        }
        const azureBaseUrl = String(body.azureBaseUrl ?? '').trim().replace(/\/+$/, '');
        if (!/^https:\/\/.+/.test(azureBaseUrl)) {
          return NextResponse.json({ ok: false, message: 'Enter your Azure OpenAI endpoint (an https:// URL).' });
        }
        const azureKey = String(body.azureKey ?? '').trim();
        const existingCustom = (await listApiKeys(user.id)).find((k) => k.service === 'custom');
        if (!azureKey && !existingCustom) {
          return NextResponse.json({ ok: false, message: 'Paste your Azure OpenAI API key.' });
        }
        if (azureKey) {
          // Probe the endpoint with the key BEFORE saving anything.
          try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 10_000);
            const res = await fetch(`${azureBaseUrl}/models`, {
              headers: { Authorization: `Bearer ${azureKey}`, 'api-key': azureKey },
              signal: ctl.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
              return NextResponse.json({
                ok: false,
                message: `Azure endpoint answered ${res.status} — check the URL (use the OpenAI-compatible /openai/v1 endpoint) and key.`,
              });
            }
          } catch (err) {
            return NextResponse.json({
              ok: false,
              message: `Couldn't reach the Azure endpoint: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          await setApiKey(user.id, 'custom', 'default', azureKey);
        }
        await updateProfilePreferences(user.id, {
          onboardingModels: { assistantModel, workerModel, route, azureBaseUrl },
        });
        return NextResponse.json({ ok: true, route, assistantModel, workerModel });
      }
      await updateProfilePreferences(user.id, {
        onboardingModels: { assistantModel, workerModel, route },
      });
      return NextResponse.json({ ok: true, route, assistantModel, workerModel });
    }
    case 'embedding': {
      // Onboarding's embedder step. The user picks the model (3-large default,
      // 3-small budget) and the route: OpenRouter — reusing the chat key saved a
      // step earlier, no second signup — or OpenAI direct. A pasted key is saved
      // and probed first; then the actual embedding route is probed at 768 dims
      // (MRL reduction) BEFORE the brain's single embedding_config is pointed at
      // it, so a provider that ignores `dimensions` can never corrupt the index.
      // Skipping leaves the keyless local fallback (opt-in, not run by default).
      const provider =
        body.provider === 'openrouter' ? 'openrouter' : DEFAULT_ONLINE_EMBEDDING_PROVIDER;
      const model =
        body.model === 'text-embedding-3-small'
          ? 'text-embedding-3-small'
          : DEFAULT_ONLINE_EMBEDDING_MODEL;
      // OpenRouter namespaces model slugs (`openai/…`); direct providers use the bare id.
      const slug = provider === 'openrouter' ? `openai/${model}` : model;
      const trimmed = String(body.plaintext ?? '').trim();

      let keyId: string;
      if (trimmed) {
        const row = await setApiKey(user.id, provider, 'default', trimmed);
        const test = await probeApiKey(row.id, provider);
        if (!test.ok) return NextResponse.json({ saved: true, configured: false, test });
        keyId = row.id;
      } else {
        const existing = (await listApiKeys(user.id)).find((k) => k.service === provider);
        if (!existing) {
          return NextResponse.json({
            saved: false,
            configured: false,
            test: { ok: false, message: `No ${provider} key saved yet — paste one first.`, provider, adapter: '' },
          });
        }
        keyId = existing.id;
      }

      try {
        const dim = await probeEmbeddingRoute(user.id, { provider, model: slug, apiKeyId: keyId });
        if (dim !== 768) {
          return NextResponse.json({
            saved: true,
            configured: false,
            test: {
              ok: false,
              message: `The route returned ${dim}-dimension vectors (need 768) — not configured.`,
              provider,
              adapter: '',
            },
          });
        }
      } catch (err) {
        return NextResponse.json({
          saved: true,
          configured: false,
          test: {
            ok: false,
            message: `Embedding test failed: ${err instanceof Error ? err.message : String(err)}`,
            provider,
            adapter: '',
          },
        });
      }

      await upsertEmbeddingConfig(user.id, {
        model: slug,
        primaryProvider: provider,
        primaryBaseUrl: null,
        primaryApiKeyId: keyId,
        primaryLabel: provider === 'openrouter' ? 'OpenRouter' : 'OpenAI',
        backupEnabled: false,
        backupProvider: null,
        backupBaseUrl: null,
        backupApiKeyId: null,
        backupLabel: null,
        extractionConcurrency: null,
        extractionTimeBudgetMinutes: null,
        localEmbedBatchSize: null,
        localEmbedRequestTimeoutMs: null,
      });
      return NextResponse.json({
        saved: true,
        configured: true,
        test: { ok: true, message: 'Memory search enabled.', provider, adapter: '' },
      });
    }
    case 'testKey': {
      const service = String(body.service ?? '');
      const keys = await listApiKeys(user.id);
      const key = keys.find((k) => k.service === service);
      if (!key) {
        return NextResponse.json({ ok: false, message: 'No key saved for this provider yet.', provider: service, adapter: '' });
      }
      return NextResponse.json(await probeApiKey(key.id, service));
    }
    case 'provision': {
      const result = await provisionDefaults(user.id);
      await updateProfilePreferences(user.id, { onboardingStep: 'sanity' });
      return NextResponse.json(result);
    }
    case 'sanity':
      return NextResponse.json(await runSanityChecks(user.id));
    case 'purpose':
      return NextResponse.json(
        await savePurpose(user.id, String(body.archetype ?? ''), String(body.purpose ?? '')),
      );
    case 'persona': {
      const parsed = PersonaInput.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'Invalid personality input.',
        });
      }
      const applied = await savePersonaAgent(user.id, parsed.data);
      await updateProfilePreferences(user.id, { onboardingStep: 'telegram' });
      if (!applied) {
        return NextResponse.json({ ok: false, error: 'No assistant agent to update — add an OpenRouter key first.' });
      }
      return NextResponse.json({ ok: true });
    }
    case 'finish': {
      // Integrity gate: never stamp onboarding complete over a dead brain. If no
      // enabled persona/responder exists (the user skipped the OpenRouter key, or
      // provisioning no-op'd), refuse — otherwise `onboardedAt` is set, the app
      // shell stops routing them to the wizard, and every chat turn fails with no
      // path back to fix it. Mirrors the persona-step guard above.
      const persona = await getAgentBySlug(user.id, PERSONA_AGENT_SLUG);
      if (!persona?.enabled) {
        return NextResponse.json({
          ok: false,
          error:
            'Your brain has no assistant yet — add an OpenRouter API key and run Set up so it can answer, then finish.',
        });
      }
      await markOnboarded(user.id);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
