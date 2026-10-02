import { z } from 'zod';
import { lookup as dnsLookup } from 'node:dns/promises';
import { db, sql } from '@mantle/db';
import { bucketStatus } from '@mantle/storage';
import { tikaVersion } from '@mantle/files';
import { loadPreferencesFor, savePreferencesFor, isPurposeArchetype } from '@mantle/content';
import { setApiKey, listApiKeys } from '@mantle/api-keys';
import {
  resolveEmbeddingConfig,
  probeEmbeddingRoute,
  DEFAULT_ONLINE_EMBEDDING_MODEL,
  DEFAULT_ONLINE_EMBEDDING_PROVIDER,
} from '@mantle/embeddings';
import { upsertEmbeddingConfig } from '@/lib/embedding-config';
import { ASSISTANT_MODEL_CHOICES, WORKER_MODEL_CHOICES } from '@mantle/client-types/model-choices';
import { PURPOSE_MAX_CHARS, purposeTooLongError } from '@mantle/client-types/purpose-limits';
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
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

/**
 * The onboarding wizard's steps, as plain functions of the owner's id and
 * plain input. Two callers: the HTTP dispatcher (app/api/onboarding/route.ts,
 * which every Jackdaw client drives) and the terminal wizard
 * (scripts/onboard.ts, for a headless brain with no client at all). One body
 * of logic, so the two cannot drift; the same idea as the system manifest.
 *
 * Each step persists immediately through existing primitives (keys, workers,
 * agents, preferences), so a run resumes from `preferences.onboardingStep`.
 * The functions return the JSON body the route answers with; none of them
 * know about requests.
 */

export type SanityCheck = { label: string; ok: boolean; detail: string };

// The only onboarding action that took an unchecked `body as SavePersonaInput`
// cast — and savePersonaAgent does `input.assistantName.trim()` with no guard,
// so a malformed body 500'd. Validate it (enums mirror PersonaPresetKey /
// PersonaGender in @mantle/content; assistantName may be blank — the lib falls
// back to a default — so no `.min`). zod strips the extra `action` field.
export const PersonaInput = z.object({
  presetKey: z.enum(['warm', 'professional', 'playful', 'concise']),
  assistantName: z.string(),
  gender: z.enum(['female', 'male']),
  temperature: z.number(),
});

/**
 * Pre-flight infra probes for the FIRST wizard step — provision-independent
 * liveness of the stack the wizard is about to build on (is every container the
 * deploy should have started actually serving?). The web app has no Docker
 * socket by design, so each service is probed FUNCTIONALLY instead: can we
 * query it / reach its endpoint. If these fail there's no point onboarding —
 * uploads, indexing and document parsing would all break — so the client
 * blocks Continue on the Welcome step until they pass.
 */
/**
 * Domain & HTTPS — verifies the box's public hostname actually works.
 * Cheapest, strongest proof first: if the browser is reaching this very
 * request THROUGH the configured domain, then DNS + certificate + proxy are
 * all proven by the page being open. Otherwise fall back to a DNS lookup and
 * a server-side self-fetch of the public URL (which validates TLS end-to-end).
 * Unset/localhost public URL is informational, not a failure — normal on a
 * dev box or a deliberately internal deployment.
 */
async function checkDomain(browserHost: string | null): Promise<SanityCheck> {
  const label = 'Domain & HTTPS';
  const configured = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
  if (!configured || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(configured)) {
    return {
      label,
      ok: true,
      detail: configured
        ? `public URL is ${configured} (local) — fine for a dev box; set MANTLE_PUBLIC_URL on a deployed one so share links work.`
        : 'no public URL configured — fine for a dev box; set MANTLE_PUBLIC_URL on a deployed one so share links work.',
    };
  }

  let host: string;
  try {
    host = new URL(configured).hostname;
  } catch {
    return { label, ok: false, detail: `MANTLE_PUBLIC_URL (“${configured}”) is not a valid URL.` };
  }

  // Proof by usage: the wizard is being served over the configured domain
  // right now — DNS, certificate, and proxy are all demonstrably working.
  const browsing = (browserHost ?? '').split(':')[0]?.toLowerCase();
  if (browsing && browsing === host.toLowerCase()) {
    return {
      label,
      ok: true,
      detail: `you're reaching ${host} right now — DNS, certificate and proxy all working.`,
    };
  }

  // Browsing via a different host (tunnel/IP) — verify the domain separately.
  try {
    await dnsLookup(host);
  } catch {
    return {
      label,
      ok: false,
      detail: `“${host}” does not resolve in DNS — point an A record at this server, then Re-check.`,
    };
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6_000);
    const res = await fetch(configured, { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(timer);
    void res;
    return {
      label,
      ok: true,
      detail: `${host} resolves and answers over HTTPS (you're browsing via ${browsing || 'another address'} — links will use ${host}).`,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      detail:
        `“${host}” resolves but ${configured} isn't answering from this server — check the certificate/proxy (some networks also block a server fetching its own public IP; if ${configured} loads in your browser, treat this as a warning): ` +
        errorMessage(err),
    };
  }
}

export async function runInfraChecks(browserHost: string | null): Promise<SanityCheck[]> {
  const checks: SanityCheck[] = [];

  // Database — trivially up if this handler runs, but probe explicitly so the
  // row is an honest measurement, not an assumption.
  try {
    await db.execute(sql`select 1`);
    checks.push({ label: 'Database (PostgreSQL)', ok: true, detail: 'answering' });
  } catch (err) {
    checks.push({
      label: 'Database (PostgreSQL)',
      ok: false,
      detail: `not answering: ${errorMessage(err)}`,
    });
  }

  // pg-boss schema — the background-job substrate every worker needs. Created
  // by the migrate one-shot / up.sh; a box that skipped it has dead workers.
  try {
    const r = await db.execute(
      sql`select 1 as ok from information_schema.schemata where schema_name = 'pgboss'`,
    );
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
    checks.push(
      rows.length > 0
        ? { label: 'Job queue (pg-boss)', ok: true, detail: 'background-job schema present' }
        : {
            label: 'Job queue (pg-boss)',
            ok: false,
            detail:
              'pgboss schema missing — background workers cannot run. The migrate one-shot creates it; bring the stack up via the documented path.',
          },
    );
  } catch (err) {
    checks.push({
      label: 'Job queue (pg-boss)',
      ok: false,
      detail: `couldn't verify: ${errorMessage(err)}`,
    });
  }

  // Object store — reachability AND the bucket (a registry-pull box that never
  // ran the migrate one-shot has the store up but no bucket).
  try {
    const s = await bucketStatus();
    if (!s.reachable) {
      checks.push({
        label: 'Object storage',
        ok: false,
        detail:
          'unreachable — is the object store container running? File uploads and app builds will fail.',
      });
    } else if (s.exists === false) {
      checks.push({
        label: 'Object storage',
        ok: false,
        detail: `up, but bucket “${s.bucket}” does not exist — uploads and app builds will fail until it's created.`,
      });
    } else {
      checks.push({
        label: 'Object storage',
        ok: true,
        detail: `bucket “${s.bucket}” reachable`,
      });
    }
  } catch (err) {
    checks.push({
      label: 'Object storage',
      ok: false,
      detail: `couldn't verify: ${errorMessage(err)}`,
    });
  }

  // Tika — the long-tail document parser (office formats, odd PDFs). A
  // brain-core box sheds it on purpose (docker-compose.core.yml; the installer
  // writes MANTLE_CORE_SHAPE=1 with --core), and common
  // formats parse in-process without it, so there it is optional: reported,
  // never blocking.
  const tika = await tikaVersion(2_500);
  const coreShape = env('MANTLE_CORE_SHAPE') === '1';
  checks.push(
    tika
      ? { label: 'Document parser (Tika)', ok: true, detail: tika }
      : coreShape
        ? {
            label: 'Document parser (Tika)',
            ok: true,
            detail:
              'not running: optional on a brain-core box. PDF, DOCX, text and markdown parse without it; add it with scripts/install.sh --helpers for .odt, .pptx, .doc and .rtf.',
          }
        : {
            label: 'Document parser (Tika)',
            ok: false,
            detail: 'not answering — is the tika container running? Office/PDF parsing will fail.',
          },
  );

  // Required secrets — the stack refuses to start without them under compose,
  // but a hand-rolled env can miss one and break key sealing silently.
  const secretsOk = !!env('MANTLE_MASTER_KEY') && !!env('SESSION_SECRET');
  checks.push(
    secretsOk
      ? { label: 'Required secrets', ok: true, detail: 'MANTLE_MASTER_KEY + SESSION_SECRET set' }
      : {
          label: 'Required secrets',
          ok: false,
          detail:
            'MANTLE_MASTER_KEY or SESSION_SECRET missing — API keys cannot be stored securely.',
        },
  );

  checks.push(await checkDomain(browserHost));

  return checks;
}

export async function runSanityChecks(userId: string): Promise<SanityCheck[]> {
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

export async function savePurpose(
  userId: string,
  archetype: string,
  purpose: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const p = (purpose ?? '').trim();
  if (!p) {
    return { ok: false, error: 'Describe what this brain is for.' };
  }
  // Refuse, never trim: a silent slice once dropped 3,288 characters of a
  // pasted persona prompt and nobody knew. The wizard counts against the same
  // limit, so only a stale or hand-rolled client reaches this.
  if (p.length > PURPOSE_MAX_CHARS) {
    return { ok: false, error: purposeTooLongError(p.length), status: 400 };
  }
  // Unknown/blank archetype falls back to 'custom' — the description is the
  // load-bearing field; the archetype is a (validated) hint.
  const key = isPurposeArchetype(archetype) ? archetype : 'custom';
  try {
    await savePreferencesFor(userId, {
      purpose: p,
      purposeArchetype: key,
      onboardingStep: 'personality',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save.' };
  }
}

/** Resume state for the wizard + the already-onboarded flag (the client honours
 *  ?force to re-run on a populated stack) + the provisioned assistant agent id. */
export async function onboardingState(userId: string) {
  const [prefs, keys, onboarded, assistantAgent] = await Promise.all([
    loadPreferencesFor(userId),
    listApiKeys(userId),
    isOnboarded(userId),
    getAgentBySlug(userId, PERSONA_AGENT_SLUG),
  ]);
  return {
    onboarded,
    step: prefs.onboardingStep ?? 'profile',
    timezone: prefs.timezone,
    locale: prefs.locale,
    savedServices: [...new Set(keys.map((k) => k.service))],
    assistantAgentId: assistantAgent?.id ?? null,
  };
}

/** The result of a key probe, as the wizard shows it. */
export type KeyTest = Awaited<ReturnType<typeof probeApiKey>>;

export async function saveStep(userId: string, step: string) {
  await savePreferencesFor(userId, { onboardingStep: step });
  return { ok: true as const };
}

export async function saveProfile(
  userId: string,
  input: { timezone: string; locale: string; displayName?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Optional "Your name": what the assistant should call the operator
    // (replaces the old interview's name questions). Stored verbatim.
    const displayName = (input.displayName ?? '').trim();
    await savePreferencesFor(userId, {
      timezone: input.timezone,
      locale: input.locale,
      ...(displayName ? { displayName } : {}),
      onboardingStep: 'openrouter',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save.' };
  }
}

export async function saveKey(
  userId: string,
  service: string,
  plaintext: string,
): Promise<{ saved: boolean; test: KeyTest }> {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    return {
      saved: false,
      test: { ok: false, message: 'Paste a key first.', provider: service, adapter: '' },
    };
  }
  const row = await setApiKey(userId, service, 'default', trimmed);
  const test = await probeApiKey(row.id, service);
  return { saved: true, test };
}

/**
 * The Models step. Stores the user's assistant + worker model picks
 * (validated against the curated lists) as the `onboardingModels` pref;
 * provisionDefaults() applies them as operator overlay on top of the
 * manifest seed. Route 'azure' additionally saves the Azure OpenAI key under
 * service 'custom' and live-probes `{baseUrl}/models` before accepting the
 * endpoint.
 */
export async function saveModels(
  userId: string,
  input: {
    assistantModel?: unknown;
    workerModel?: unknown;
    route?: unknown;
    azureBaseUrl?: unknown;
    azureKey?: unknown;
  },
) {
  const assistantModel = ASSISTANT_MODEL_CHOICES.find((m) => m.id === input.assistantModel)?.id;
  const workerModel = WORKER_MODEL_CHOICES.find((m) => m.id === input.workerModel)?.id;
  const route = input.route === 'azure' ? 'azure' : 'openrouter';
  if (!assistantModel || !workerModel) {
    return { ok: false as const, message: 'Pick an assistant model and a worker model.' };
  }
  if (route === 'azure') {
    const aOk = ASSISTANT_MODEL_CHOICES.find((m) => m.id === assistantModel)?.azure === true;
    const wOk = WORKER_MODEL_CHOICES.find((m) => m.id === workerModel)?.azure === true;
    if (!aOk || !wOk) {
      return {
        ok: false as const,
        message: 'On Azure, pick OpenAI-family models (marked Azure-capable).',
      };
    }
    const azureBaseUrl = String(input.azureBaseUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (!/^https:\/\/.+/.test(azureBaseUrl)) {
      return { ok: false as const, message: 'Enter your Azure OpenAI endpoint (an https:// URL).' };
    }
    const azureKey = String(input.azureKey ?? '').trim();
    const existingCustom = (await listApiKeys(userId)).find((k) => k.service === 'custom');
    if (!azureKey && !existingCustom) {
      return { ok: false as const, message: 'Paste your Azure OpenAI API key.' };
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
          return {
            ok: false as const,
            message: `Azure endpoint answered ${res.status} — check the URL (use the OpenAI-compatible /openai/v1 endpoint) and key.`,
          };
        }
      } catch (err) {
        return {
          ok: false as const,
          message: `Couldn't reach the Azure endpoint: ${errorMessage(err)}`,
        };
      }
      await setApiKey(userId, 'custom', 'default', azureKey);
    }
    await savePreferencesFor(userId, {
      onboardingModels: { assistantModel, workerModel, route, azureBaseUrl },
    });
    return { ok: true as const, route, assistantModel, workerModel };
  }
  await savePreferencesFor(userId, {
    onboardingModels: { assistantModel, workerModel, route },
  });
  return { ok: true as const, route, assistantModel, workerModel };
}

/**
 * The embedder step. The user picks the model (3-large default, 3-small
 * budget) and the route: OpenRouter, reusing the chat key saved a step
 * earlier (no second signup), or OpenAI direct. A pasted key is saved and
 * probed first; then the actual embedding route is probed at 768 dims (MRL
 * reduction) BEFORE the brain's single embedding_config is pointed at it, so
 * a provider that ignores `dimensions` can never corrupt the index.
 * Skipping leaves the keyless local fallback (opt-in, not run by default).
 */
export async function saveEmbedding(
  userId: string,
  input: { provider?: unknown; model?: unknown; plaintext?: unknown },
): Promise<{ saved: boolean; configured: boolean; test: KeyTest }> {
  const provider =
    input.provider === 'openrouter' ? 'openrouter' : DEFAULT_ONLINE_EMBEDDING_PROVIDER;
  const model =
    input.model === 'text-embedding-3-small'
      ? 'text-embedding-3-small'
      : DEFAULT_ONLINE_EMBEDDING_MODEL;
  // OpenRouter namespaces model slugs (`openai/…`); direct providers use the bare id.
  const slug = provider === 'openrouter' ? `openai/${model}` : model;
  const trimmed = String(input.plaintext ?? '').trim();

  let keyId: string;
  if (trimmed) {
    const row = await setApiKey(userId, provider, 'default', trimmed);
    const test = await probeApiKey(row.id, provider);
    if (!test.ok) return { saved: true, configured: false, test };
    keyId = row.id;
  } else {
    const existing = (await listApiKeys(userId)).find((k) => k.service === provider);
    if (!existing) {
      return {
        saved: false,
        configured: false,
        test: {
          ok: false,
          message: `No ${provider} key saved yet — paste one first.`,
          provider,
          adapter: '',
        },
      };
    }
    keyId = existing.id;
  }

  try {
    const dim = await probeEmbeddingRoute(userId, { provider, model: slug, apiKeyId: keyId });
    if (dim !== 768) {
      return {
        saved: true,
        configured: false,
        test: {
          ok: false,
          message: `The route returned ${dim}-dimension vectors (need 768) — not configured.`,
          provider,
          adapter: '',
        },
      };
    }
  } catch (err) {
    return {
      saved: true,
      configured: false,
      test: {
        ok: false,
        message: `Embedding test failed: ${errorMessage(err)}`,
        provider,
        adapter: '',
      },
    };
  }

  await upsertEmbeddingConfig(userId, {
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
  return {
    saved: true,
    configured: true,
    test: { ok: true, message: 'Memory search enabled.', provider, adapter: '' },
  };
}

export async function testKey(userId: string, service: string): Promise<KeyTest> {
  const keys = await listApiKeys(userId);
  const key = keys.find((k) => k.service === service);
  if (!key) {
    return {
      ok: false,
      message: 'No key saved for this provider yet.',
      provider: service,
      adapter: '',
    };
  }
  return probeApiKey(key.id, service);
}

export async function provision(userId: string) {
  const result = await provisionDefaults(userId);
  await savePreferencesFor(userId, { onboardingStep: 'sanity' });
  // The wizard's resume-state snapshot predates this agent (fresh brain →
  // assistantAgentId was null at mount), so hand the id back here for the
  // Telegram step. Resolved by slug, not from `createdAgent`, so an
  // idempotent re-run (agent already existed, createdAgent null) works too.
  const persona = await getAgentBySlug(userId, PERSONA_AGENT_SLUG);
  return { ...result, assistantAgentId: persona?.id ?? null };
}

export async function savePersona(
  userId: string,
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = PersonaInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error, 'Invalid personality input.') };
  }
  const applied = await savePersonaAgent(userId, parsed.data);
  await savePreferencesFor(userId, { onboardingStep: 'telegram' });
  if (!applied) {
    return { ok: false, error: 'No assistant agent to update — add an OpenRouter key first.' };
  }
  return { ok: true };
}

/**
 * Integrity gate: never stamp onboarding complete over a dead brain. If no
 * enabled persona/responder exists (the user skipped the OpenRouter key, or
 * provisioning no-op'd), refuse; otherwise `onboardedAt` is set, the app
 * shell stops routing them to the wizard, and every chat turn fails with no
 * path back to fix it. Mirrors the persona-step guard above.
 */
export async function finishOnboarding(userId: string): Promise<{ ok: boolean; error?: string }> {
  const persona = await getAgentBySlug(userId, PERSONA_AGENT_SLUG);
  if (!persona?.enabled) {
    return {
      ok: false,
      error:
        'Your brain has no assistant yet — add an OpenRouter API key and run Set up so it can answer, then finish.',
    };
  }
  await markOnboarded(userId);
  return { ok: true };
}
