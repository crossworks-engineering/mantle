import { NextResponse } from 'next/server';
import {
  loadProfilePreferences,
  updateProfilePreferences,
  createLifelog,
  listLifelogs,
  deleteLifelog,
  composeBody,
  deriveDisplayName,
  ONBOARDING_QUESTIONS,
} from '@mantle/content';
import { setApiKey, listApiKeys } from '@mantle/api-keys';
import { resolveEmbeddingConfig, probeEmbeddingRoute } from '@mantle/embeddings';
import { getOwnerOr401 } from '@/lib/auth';
import { probeApiKey } from '@/lib/api-key-test';
import {
  provisionDefaults,
  savePersonaAgent,
  PERSONA_AGENT_SLUG,
  type SavePersonaInput,
} from '@/lib/onboarding-provision';
import { checkSystemIntegrity } from '@/lib/system-manifest';
import { isOnboarded, markOnboarded } from '@/lib/onboarding';
import { listAiWorkers } from '@/lib/ai-workers';
import { getAgentBySlug } from '@/lib/agents';

export const dynamic = 'force-dynamic';

/**
 * Onboarding wizard backend — the first-run flow's reads (GET) + every step's
 * mutation (POST, dispatched by `action`). Each step persists immediately
 * through existing primitives (keys, workers, agents, life logs, preferences)
 * so a refresh resumes from `preferences.onboardingStep`. Consolidated to one
 * route because it's a single internal flow (replaces app/onboarding/actions.ts).
 */

export type SanityCheck = { label: string; ok: boolean; detail: string };
const ONBOARDING_LIFELOG_TAG = 'onboarding';

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

async function saveInterview(
  userId: string,
  answers: Record<string, string>,
): Promise<{ ok: boolean; created: number; error?: string }> {
  if (!(answers['full_name'] ?? '').trim() || !(answers['nickname'] ?? '').trim()) {
    return { ok: false, created: 0, error: 'Your name and what to call you are required.' };
  }
  try {
    // Idempotent: clear the life logs a previous run created (tagged
    // `onboarding`) before recreating — never touches the user's own entries.
    const prior = await listLifelogs(userId, { tag: ONBOARDING_LIFELOG_TAG });
    for (const p of prior) await deleteLifelog(userId, p.id);
    let created = 0;
    for (const q of ONBOARDING_QUESTIONS) {
      const body = composeBody(q, answers[q.key] ?? '');
      if (!body) continue;
      await createLifelog(userId, { body, category: q.category, tags: [ONBOARDING_LIFELOG_TAG] });
      created++;
    }
    const displayName =
      (answers['nickname'] ?? '').trim() || deriveDisplayName(answers['full_name'] ?? '');
    await updateProfilePreferences(userId, {
      ...(displayName ? { displayName } : {}),
      onboardingStep: 'personality',
    });
    return { ok: true, created };
  } catch (err) {
    return { ok: false, created: 0, error: err instanceof Error ? err.message : 'Could not save.' };
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
        await updateProfilePreferences(user.id, {
          timezone: String(body.timezone ?? ''),
          locale: String(body.locale ?? ''),
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
    case 'interview':
      return NextResponse.json(
        await saveInterview(user.id, (body.answers ?? {}) as Record<string, string>),
      );
    case 'persona': {
      const applied = await savePersonaAgent(user.id, body as unknown as SavePersonaInput);
      await updateProfilePreferences(user.id, { onboardingStep: 'telegram' });
      if (!applied) {
        return NextResponse.json({ ok: false, error: 'No assistant agent to update — add an OpenRouter key first.' });
      }
      return NextResponse.json({ ok: true });
    }
    case 'finish': {
      await markOnboarded(user.id);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
