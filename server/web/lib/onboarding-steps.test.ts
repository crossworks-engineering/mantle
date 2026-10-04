/**
 * The onboarding steps without a database (headless onboarding audit item
 * 10): the stack check's Tika row per deploy shape, and the validation paths
 * of the steps both wizards share. Every dependency is stood in; what is
 * asserted is the decision each step makes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_MODEL_CHOICES, WORKER_MODEL_CHOICES } from '@mantle/client-types/model-choices';

const h = vi.hoisted(() => ({
  tika: null as string | null,
  prefs: [] as Record<string, unknown>[],
  keys: [] as { id: string; service: string }[],
  probeDim: 768 as number | Error,
  embeddingSaved: 0,
  embeddingInput: null as Record<string, unknown> | null,
  personaApplied: true,
  agent: null as { id: string; enabled: boolean } | null,
  marked: 0,
}));

vi.mock('@mantle/db', () => ({
  db: { execute: async () => [{ ok: 1 }] },
  sql: () => ({}),
}));
vi.mock('@mantle/storage', () => ({
  bucketStatus: async () => ({ reachable: true, exists: true, bucket: 'mantle' }),
}));
vi.mock('@mantle/files', () => ({ tikaVersion: async () => h.tika }));
vi.mock('@mantle/content', () => ({
  loadPreferencesFor: async () => ({}),
  savePreferencesFor: async (_u: string, p: Record<string, unknown>) => {
    h.prefs.push(p);
  },
  isPurposeArchetype: (k: string) => k === 'personal',
}));
vi.mock('@mantle/api-keys', () => ({
  setApiKey: async (_u: string, service: string) => ({ id: `key-${service}` }),
  listApiKeys: async () => h.keys,
}));
vi.mock('@mantle/embeddings', () => ({
  resolveEmbeddingConfig: async () => ({}),
  probeEmbeddingRoute: async () => {
    if (h.probeDim instanceof Error) throw h.probeDim;
    return h.probeDim;
  },
  DEFAULT_ONLINE_EMBEDDING_MODEL: 'text-embedding-3-large',
  DEFAULT_ONLINE_EMBEDDING_PROVIDER: 'openai',
}));
vi.mock('@/lib/embedding-config', () => ({
  upsertEmbeddingConfig: async (_u: string, input: Record<string, unknown>) => {
    h.embeddingSaved += 1;
    h.embeddingInput = input;
  },
}));
vi.mock('@/lib/api-key-test', () => ({
  probeApiKey: async (_id: string, service: string) => ({
    ok: true,
    message: 'ok',
    provider: service,
    adapter: '',
  }),
}));
vi.mock('@/lib/onboarding-provision', () => ({
  provisionDefaults: async () => ({}),
  savePersonaAgent: async () => h.personaApplied,
  PERSONA_AGENT_SLUG: 'assistant',
}));
vi.mock('@/lib/system-manifest', () => ({ checkSystemIntegrity: async () => ({ checks: [] }) }));
vi.mock('@/lib/onboarding', () => ({
  isOnboarded: async () => false,
  markOnboarded: async () => {
    h.marked += 1;
  },
}));
vi.mock('@/lib/ai-workers', () => ({ listAiWorkers: async () => [] }));
vi.mock('@/lib/agents', () => ({ getAgentBySlug: async () => h.agent }));

import {
  finishOnboarding,
  runInfraChecks,
  saveEmbedding,
  saveModels,
  savePersona,
  saveProfile,
} from './onboarding-steps';
import { composeShapeFrom, tikaIsOptional } from './compose-shape';

const U = 'owner-1';

beforeEach(() => {
  h.tika = null;
  h.prefs = [];
  h.keys = [];
  h.probeDim = 768;
  h.embeddingSaved = 0;
  h.embeddingInput = null;
  h.personaApplied = true;
  h.agent = null;
  h.marked = 0;
  delete process.env.MANTLE_COMPOSE_FILE;
  delete process.env.MANTLE_COMPOSE_PROFILES;
});

describe('compose shape (derived from COMPOSE_FILE / COMPOSE_PROFILES)', () => {
  const CORE = '/srv/b/docker-compose.yml:/srv/b/docker-compose.core.yml';
  it('core without helpers: Tika optional', () => {
    expect(tikaIsOptional(composeShapeFrom(CORE, 'sandboxes'))).toBe(true);
    expect(tikaIsOptional(composeShapeFrom(CORE, ''))).toBe(true);
  });
  it('core WITH helpers: Tika required (a crashed Tika must not pass)', () => {
    expect(tikaIsOptional(composeShapeFrom(CORE, 'sandboxes, helpers'))).toBe(false);
  });
  it('full shape, or nothing set: Tika required', () => {
    expect(tikaIsOptional(composeShapeFrom('/srv/b/docker-compose.yml', 'helpers'))).toBe(false);
    expect(tikaIsOptional(composeShapeFrom(undefined, undefined))).toBe(false);
  });
});

describe('runInfraChecks: the Tika row', () => {
  const tikaRow = async () =>
    (await runInfraChecks(null)).find((c) => c.label === 'Document parser (Tika)')!;
  const CORE = '/srv/b/docker-compose.yml:/srv/b/docker-compose.core.yml';

  it('core + no helpers, Tika down: optional, passes, says how to add it', async () => {
    process.env.MANTLE_COMPOSE_FILE = CORE;
    process.env.MANTLE_COMPOSE_PROFILES = 'sandboxes';
    const row = await tikaRow();
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/optional on a brain-core box/);
    expect(row.detail).toMatch(/\.xls/);
  });

  it('core + helpers, Tika down: fails', async () => {
    process.env.MANTLE_COMPOSE_FILE = CORE;
    process.env.MANTLE_COMPOSE_PROFILES = 'helpers';
    expect((await tikaRow()).ok).toBe(false);
  });

  it('full shape, Tika down: fails', async () => {
    process.env.MANTLE_COMPOSE_FILE = '/srv/b/docker-compose.yml';
    expect((await tikaRow()).ok).toBe(false);
  });

  it('unset (dev, an older compose), Tika down: fails', async () => {
    expect((await tikaRow()).ok).toBe(false);
  });

  it('Tika answering passes on every shape', async () => {
    h.tika = 'Apache Tika 3.3.1';
    expect(await tikaRow()).toMatchObject({ ok: true, detail: 'Apache Tika 3.3.1' });
    process.env.MANTLE_COMPOSE_FILE = CORE;
    expect((await tikaRow()).ok).toBe(true);
  });
});

describe('saveProfile', () => {
  it('a value that cannot be turned into text answers ok:false, not a throw', async () => {
    const r = await saveProfile(U, { timezone: { toString: 1 }, locale: 'en-GB' });
    expect(r.ok).toBe(false);
    expect(h.prefs).toEqual([]);
  });
  it('saves and moves on to the key step', async () => {
    expect(
      await saveProfile(U, { timezone: 'UTC', locale: 'en-GB', displayName: ' Sam ' }),
    ).toEqual({ ok: true });
    expect(h.prefs[0]).toMatchObject({ displayName: 'Sam', onboardingStep: 'openrouter' });
  });
});

describe('saveModels', () => {
  const a = ASSISTANT_MODEL_CHOICES.find((m) => m.recommended)!.id;
  const w = WORKER_MODEL_CHOICES.find((m) => m.recommended)!.id;
  const nonAzure = ASSISTANT_MODEL_CHOICES.find((m) => !m.azure)!.id;
  const azureA = ASSISTANT_MODEL_CHOICES.find((m) => m.azure)!.id;
  const azureW = WORKER_MODEL_CHOICES.find((m) => m.azure)!.id;

  it('refuses ids outside the curated lists', async () => {
    expect(await saveModels(U, { assistantModel: 'evil/model', workerModel: w })).toMatchObject({
      ok: false,
      message: 'Pick an assistant model and a worker model.',
    });
    expect(h.prefs).toEqual([]);
  });
  it('Azure: refuses models that are not Azure-capable, and a non-https endpoint', async () => {
    expect(
      await saveModels(U, { assistantModel: nonAzure, workerModel: azureW, route: 'azure' }),
    ).toMatchObject({ ok: false, message: /Azure-capable/ });
    expect(
      await saveModels(U, {
        assistantModel: azureA,
        workerModel: azureW,
        route: 'azure',
        azureBaseUrl: 'http://plain.example.invalid',
      }),
    ).toMatchObject({ ok: false, message: /https:\/\/ URL/ });
    expect(
      await saveModels(U, {
        assistantModel: azureA,
        workerModel: azureW,
        route: 'azure',
        azureBaseUrl: 'https://x.example.invalid/openai/v1',
      }),
    ).toMatchObject({ ok: false, message: /Paste your Azure OpenAI API key/ });
  });
  it('OpenRouter: stores the picks', async () => {
    expect(await saveModels(U, { assistantModel: a, workerModel: w })).toMatchObject({
      ok: true,
      route: 'openrouter',
    });
    expect(h.prefs[0]).toEqual({
      onboardingModels: { assistantModel: a, workerModel: w, route: 'openrouter' },
    });
  });
});

describe('saveEmbedding', () => {
  it('no key saved and none pasted: nothing configured', async () => {
    const r = await saveEmbedding(U, { provider: 'openrouter' });
    expect(r).toMatchObject({ saved: false, configured: false });
    expect(r.test.message).toMatch(/No openrouter key saved yet/);
  });
  it('a route that is not 768-dimension is never configured', async () => {
    h.keys = [{ id: 'k1', service: 'openrouter' }];
    h.probeDim = 1536;
    const r = await saveEmbedding(U, { provider: 'openrouter' });
    expect(r).toMatchObject({ configured: false });
    expect(r.test.message).toMatch(/1536-dimension/);
    expect(h.embeddingSaved).toBe(0);
  });
  it('a failing probe is reported, not configured', async () => {
    h.keys = [{ id: 'k1', service: 'openrouter' }];
    h.probeDim = new Error('401');
    const r = await saveEmbedding(U, { provider: 'openrouter' });
    expect(r.test.message).toMatch(/Embedding test failed: 401/);
    expect(h.embeddingSaved).toBe(0);
  });
  it('a 768-dimension route on the saved key is configured', async () => {
    h.keys = [{ id: 'k1', service: 'openrouter' }];
    expect(await saveEmbedding(U, { provider: 'openrouter' })).toMatchObject({ configured: true });
    expect(h.embeddingSaved).toBe(1);
    // No OpenAI key saved: no same-model backup to set.
    expect(h.embeddingInput).toMatchObject({ backupEnabled: false, backupProvider: null });
  });
  it('OpenAI direct with the OpenRouter chat key saved gets an OpenRouter backup by default', async () => {
    h.keys = [{ id: 'k-or', service: 'openrouter' }];
    expect(await saveEmbedding(U, { provider: 'openai', plaintext: 'sk-test' })).toMatchObject({
      configured: true,
    });
    expect(h.embeddingInput).toMatchObject({
      model: 'text-embedding-3-large',
      primaryProvider: 'openai',
      backupEnabled: true,
      backupProvider: 'openrouter',
      backupApiKeyId: 'k-or',
    });
  });
});

describe('savePersona', () => {
  const valid = { presetKey: 'warm', assistantName: 'Sam', gender: 'female', temperature: 0.7 };
  it('refuses a malformed body (it used to 500)', async () => {
    const r = await savePersona(U, { ...valid, presetKey: 'grumpy' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(h.prefs).toEqual([]);
  });
  it('no assistant to update: says to add a key first', async () => {
    h.personaApplied = false;
    expect(await savePersona(U, valid)).toMatchObject({ ok: false, error: /OpenRouter key first/ });
  });
  it('saves and moves on to Telegram', async () => {
    expect(await savePersona(U, valid)).toEqual({ ok: true });
    expect(h.prefs.at(-1)).toEqual({ onboardingStep: 'telegram' });
  });
});

describe('finishOnboarding', () => {
  it('refuses with no assistant, or a disabled one, and stamps nothing', async () => {
    expect((await finishOnboarding(U)).ok).toBe(false);
    h.agent = { id: 'a', enabled: false };
    expect((await finishOnboarding(U)).ok).toBe(false);
    expect(h.marked).toBe(0);
  });
  it('stamps onboarded once the assistant is enabled', async () => {
    h.agent = { id: 'a', enabled: true };
    expect(await finishOnboarding(U)).toEqual({ ok: true });
    expect(h.marked).toBe(1);
  });
});
