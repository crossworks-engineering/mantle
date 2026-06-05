'use server';

/**
 * Server actions backing the first-run onboarding wizard. Each step persists
 * immediately through existing primitives (keys, workers, agents, life logs,
 * preferences) so a refresh resumes from `preferences.onboardingStep`. Nothing
 * here is bespoke storage — the wizard is a guided front-end over the same
 * surfaces the settings pages use.
 */

import {
  loadProfilePreferences,
  updateProfilePreferences,
  createLifelog,
  listLifelogs,
  deleteLifelog,
  composeBody,
  deriveDisplayName,
  ONBOARDING_QUESTIONS,
  type PersonaGender,
  type PersonaPresetKey,
} from '@mantle/content';
import { db, agents, skills, eq, and, inArray, type AgentMemoryConfig } from '@mantle/db';
import { setApiKey, listApiKeys } from '@mantle/api-keys';
import { resolveEmbeddingConfig, probeEmbeddingRoute } from '@mantle/embeddings';
import { requireOwner } from '@/lib/auth';
import { testApiKeyAction, type TestApiKeyResult } from '@/app/(app)/settings/keys/actions';
import {
  provisionDefaults,
  savePersonaAgent,
  PERSONA_AGENT_SLUG,
  type ProvisionResult,
  type SavePersonaInput,
} from '@/lib/onboarding-provision';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';
import { markOnboarded } from '@/lib/onboarding';
import { listAiWorkers } from '@/lib/ai-workers';

/** Persist the furthest step the user has reached (resume marker). */
export async function setOnboardingStep(step: string): Promise<void> {
  const user = await requireOwner();
  await updateProfilePreferences(user.id, { onboardingStep: step });
}

/** Step 1 — profile basics (timezone + locale). */
export async function saveProfileStep(input: {
  timezone: string;
  locale: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireOwner();
  try {
    await updateProfilePreferences(user.id, {
      timezone: input.timezone,
      locale: input.locale,
      onboardingStep: 'openrouter',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save.' };
  }
}

/** Steps 2–4 — save a provider key under the 'default' label, then probe it. */
export async function saveAndTestKey(
  service: string,
  plaintext: string,
): Promise<{ saved: boolean; test: TestApiKeyResult }> {
  const user = await requireOwner();
  const trimmed = plaintext.trim();
  if (!trimmed) {
    return {
      saved: false,
      test: { ok: false, message: 'Paste a key first.', provider: service, adapter: '' },
    };
  }
  const row = await setApiKey(user.id, service, 'default', trimmed);
  const test = await testApiKeyAction(row.id, service);
  return { saved: true, test };
}

/** Re-test an already-saved key (the "Test again" button) without re-entering it. */
export async function testExistingKey(service: string): Promise<TestApiKeyResult> {
  const user = await requireOwner();
  const keys = await listApiKeys(user.id);
  const key = keys.find((k) => k.service === service);
  if (!key) {
    return { ok: false, message: 'No key saved for this provider yet.', provider: service, adapter: '' };
  }
  return testApiKeyAction(key.id, service);
}

/** Which provider keys are already saved (drives the step ticks on resume). */
export async function savedKeyServices(): Promise<string[]> {
  const user = await requireOwner();
  const keys = await listApiKeys(user.id);
  return [...new Set(keys.map((k) => k.service))];
}

/** Step — provision the agent + AI-worker set. OpenRouter covers chat, indexing,
 *  vision, and image generation; voice (tts/stt) is added on a dedicated xAI key
 *  when one was provided. Driven entirely by which keys exist. */
export async function provisionStep(): Promise<ProvisionResult> {
  const user = await requireOwner();
  const result = await provisionDefaults(user.id);
  await updateProfilePreferences(user.id, { onboardingStep: 'sanity' });
  return result;
}

export type SanityCheck = { label: string; ok: boolean; detail: string };

/** Step 6 — a green/red checklist so the user can see it all works. */
export async function runSanityChecks(): Promise<SanityCheck[]> {
  const user = await requireOwner();
  const checks: SanityCheck[] = [];

  const keys = await listApiKeys(user.id);
  const byService = new Map(keys.map((k) => [k.service, k] as const));

  // OpenRouter — chat, memory indexing, image reading + generation.
  const orKey = byService.get('openrouter');
  if (orKey) {
    const t = await testApiKeyAction(orKey.id, 'openrouter');
    checks.push({ label: 'OpenRouter (chat, images)', ok: t.ok, detail: t.message });
  }
  // xAI — voice (only present if the user added it).
  const xaiKey = byService.get('xai');
  if (xaiKey) {
    const t = await testApiKeyAction(xaiKey.id, 'xai');
    checks.push({ label: 'xAI (voice: speak + transcribe)', ok: t.ok, detail: t.message });
  }

  // Embeddings — local by default; probe the resolved primary route.
  try {
    const cfg = await resolveEmbeddingConfig(user.id);
    const dim = await probeEmbeddingRoute(user.id, {
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

  // The assistant agent exists + is enabled — plus the linkage that makes it
  // actually work (tools to act with, the shared behaviour skills).
  const [agent] = await db
    .select({
      name: agents.name,
      enabled: agents.enabled,
      toolSlugs: agents.toolSlugs,
      skillSlugs: agents.skillSlugs,
      memoryConfig: agents.memoryConfig,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.slug, PERSONA_AGENT_SLUG)))
    .limit(1);
  checks.push({
    label: 'Your assistant',
    ok: Boolean(agent?.enabled),
    detail: agent ? `${agent.name} is ready` : 'no assistant agent — add an OpenRouter key',
  });

  // Assistant capability — without tools it can't search/save/delegate; without
  // the grounding skills it answers from memory instead of the user's data.
  if (agent) {
    const nTools = agent.toolSlugs?.length ?? 0;
    const canDelegate = (agent.toolSlugs ?? []).includes('invoke_agent');
    const skillSet = new Set(agent.skillSlugs ?? []);
    const grounded = skillSet.has('tool_grounding') && skillSet.has('voice_reply');
    checks.push({
      label: 'Assistant capabilities',
      ok: nTools > 0 && canDelegate && grounded,
      detail:
        nTools === 0
          ? 'NO tools attached — the assistant can’t act yet'
          : `${nTools} tools · ${canDelegate ? 'can delegate' : 'cannot delegate (no invoke_agent)'} · ${grounded ? 'grounded + voice skills' : 'missing grounding/voice skills'}`,
    });
  }

  // Memory workers — the always-on indexing/summarising/reflecting pipeline.
  const workers = await listAiWorkers(user.id);
  const enabledKinds = new Set<string>(workers.filter((w) => w.enabled).map((w) => w.kind));
  const memNeed = ['extractor', 'summarizer', 'reflector', 'document'];
  const memMissing = memNeed.filter((k) => !enabledKinds.has(k));
  checks.push({
    label: 'Memory workers',
    ok: memMissing.length === 0,
    detail: memMissing.length
      ? `missing: ${memMissing.join(', ')}`
      : 'extractor · summarizer · reflector · document ready',
  });

  // Specialists + delegation — the agents Saskia hands off to, and whether
  // they're actually wired into her delegate_to + carry their skills.
  const SPEC = [
    { slug: 'pages', label: 'Pages', skill: 'page_editing' },
    { slug: 'tables', label: 'Ledger', skill: 'table_authoring' },
    { slug: 'remy', label: 'Remy', skill: null },
    { slug: 'researcher', label: 'Researcher', skill: null },
  ] as const;
  const specRows = await db
    .select({ slug: agents.slug, enabled: agents.enabled, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, user.id),
        inArray(
          agents.slug,
          SPEC.map((s) => s.slug),
        ),
      ),
    );
  const specBySlug = new Map(specRows.map((r) => [r.slug, r] as const));
  const delegateTo = new Set(
    ((agent?.memoryConfig as AgentMemoryConfig | null)?.delegate_to ?? []) as string[],
  );
  const specProblems: string[] = [];
  for (const s of SPEC) {
    const row = specBySlug.get(s.slug);
    if (!row || !row.enabled) {
      specProblems.push(`${s.label} missing`);
      continue;
    }
    if (!delegateTo.has(s.slug)) specProblems.push(`${s.label} not delegated`);
    if (s.skill && !(row.skillSlugs ?? []).includes(s.skill)) {
      specProblems.push(`${s.label} skill unlinked`);
    }
  }
  checks.push({
    label: 'Specialists & delegation',
    ok: specProblems.length === 0,
    detail: specProblems.length
      ? specProblems.join(' · ')
      : 'Pages · Ledger · Remy · Researcher seeded, wired + skilled',
  });

  // Editor Assist — the /pages and /tables in-editor panels must resolve to an
  // agent or they 409. Confirms the seed + the configurable binding line up.
  const [pagesAssist, tablesAssist] = await Promise.all([
    resolveAssistAgentSlug(user.id, 'pages'),
    resolveAssistAgentSlug(user.id, 'tables'),
  ]);
  checks.push({
    label: 'Editor assistants (/pages, /tables)',
    ok: Boolean(pagesAssist) && Boolean(tablesAssist),
    detail:
      pagesAssist && tablesAssist
        ? `pages → ${pagesAssist} · tables → ${tablesAssist}`
        : `unresolved — ${!pagesAssist ? 'no Pages agent' : ''}${!pagesAssist && !tablesAssist ? ', ' : ''}${!tablesAssist ? 'no Tables agent' : ''}`,
  });

  // Voice & images — only reported when they were enabled (a tts worker exists).
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

const ONBOARDING_LIFELOG_TAG = 'onboarding';

/** Step 7 — the get-to-know-you interview → one Life Log per answer. */
export async function saveInterview(
  answers: Record<string, string>,
): Promise<{ ok: boolean; created: number; error?: string }> {
  const user = await requireOwner();
  // Server-side guard for the two required questions (the client gates too).
  if (!(answers['full_name'] ?? '').trim() || !(answers['nickname'] ?? '').trim()) {
    return { ok: false, created: 0, error: 'Your name and what to call you are required.' };
  }
  try {
    // Idempotent: re-running the interview (Back → forward) must not pile up
    // duplicate life logs. Clear the ones a previous run created (tagged
    // `onboarding`) before recreating — never touches the user's own entries.
    const prior = await listLifelogs(user.id, { tag: ONBOARDING_LIFELOG_TAG });
    for (const p of prior) await deleteLifelog(user.id, p.id);

    let created = 0;
    for (const q of ONBOARDING_QUESTIONS) {
      const body = composeBody(q, answers[q.key] ?? '');
      if (!body) continue;
      await createLifelog(user.id, { body, category: q.category, tags: [ONBOARDING_LIFELOG_TAG] });
      created++;
    }
    // Prefer the nickname as the display name; fall back to the first name.
    const displayName =
      (answers['nickname'] ?? '').trim() || deriveDisplayName(answers['full_name'] ?? '');
    await updateProfilePreferences(user.id, {
      ...(displayName ? { displayName } : {}),
      onboardingStep: 'personality',
    });
    return { ok: true, created };
  } catch (err) {
    return { ok: false, created: 0, error: err instanceof Error ? err.message : 'Could not save.' };
  }
}

/** Step 8 — apply the chosen personality to the assistant agent. */
export async function savePersonaStep(
  input: SavePersonaInput,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireOwner();
  const applied = await savePersonaAgent(user.id, input);
  await updateProfilePreferences(user.id, { onboardingStep: 'telegram' });
  if (!applied) {
    return { ok: false, error: 'No assistant agent to update — add an OpenRouter key first.' };
  }
  return { ok: true };
}

// Step 9 (Telegram) no longer has a server action: the wizard reuses the shared
// <TelegramBotSection> + the `/api/agents/[id]/telegram` routes (the same flow
// as /settings/agents) to connect the bot and approve pairing inline.

/** Final — mark onboarding complete. */
export async function finishOnboarding(): Promise<void> {
  const user = await requireOwner();
  await markOnboarded(user.id);
}

/** Initial data for the wizard (resume support). */
export async function loadOnboardingState(): Promise<{
  step: string | null;
  displayName: string | null;
  savedServices: string[];
}> {
  const user = await requireOwner();
  const prefs = await loadProfilePreferences(user.id);
  const keys = await listApiKeys(user.id);
  return {
    step: prefs.onboardingStep ?? null,
    displayName: prefs.displayName ?? null,
    savedServices: [...new Set(keys.map((k) => k.service))],
  };
}
