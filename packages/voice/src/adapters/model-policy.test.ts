/**
 * The box policy's one model check (docs/policy.md) runs in the recording
 * wrappers every registry adapter goes through: a blocked provider or model
 * is refused before the adapter is called, on every capability, and opens
 * the `model_policy` alert. With no model rule every call goes through as
 * before and nothing is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';
import { ModelPolicyError, classifyProviderError, domainErrorAnswer } from '@mantle/std';

const h = vi.hoisted(() => ({ alerts: [] as unknown[] }));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  resolveSingleOwnerId: async () => '00000000-0000-4000-8000-000000000001',
  recordProviderFailure: async (...args: unknown[]) => {
    h.alerts.push(args);
    return null;
  },
}));
vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  recordUsage: () => 0,
}));

import { resetModelPolicyAlertThrottleForTests } from './model-policy';
import {
  recordingChat,
  recordingDecision,
  recordingEmbedding,
  recordingImageGen,
  recordingStt,
  recordingTts,
  recordingVision,
} from './spend';
import type {
  ChatDispatcher,
  DecisionDispatcher,
  EmbeddingDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
} from './types';

let calls = 0;
const hit = <T>(v: T) => {
  calls += 1;
  return v;
};

/** One fresh adapter of each capability on `provider` (the wrappers cache
 *  per adapter object). */
function adapters(provider: string) {
  const p = provider as never;
  return {
    chat: recordingChat({
      providerId: p,
      chat: async () => hit({ text: 'ok', model: 'm' }),
      chatStream: async () => hit({ text: 'ok', model: 'm' }),
    } as unknown as ChatDispatcher),
    decide: recordingDecision({
      providerId: p,
      decide: async () => hit({ model: 'm' }),
    } as unknown as DecisionDispatcher),
    embed: recordingEmbedding({
      providerId: p,
      embed: async () => hit({ vectors: [], model: 'm' }),
    } as unknown as EmbeddingDispatcher),
    vision: recordingVision({
      providerId: p,
      extract: async () => hit({ text: '', model: 'm' }),
    } as unknown as VisionDispatcher),
    image: recordingImageGen({
      providerId: p,
      generate: async () => hit({ model: 'm' }),
    } as unknown as ImageGenDispatcher),
    tts: recordingTts({
      providerId: p,
      synthesize: async () => hit({ model: 'm' }),
    } as unknown as TtsDispatcher),
    stt: recordingStt({
      providerId: p,
      transcribe: async () => hit({ text: '', model: 'm' }),
    } as unknown as SttDispatcher),
  };
}

/** Every capability's call with `model`. */
function callsWith(a: ReturnType<typeof adapters>, model: string): Array<() => Promise<unknown>> {
  return [
    () => a.chat.chat({ model, messages: [] } as never),
    () => a.chat.chatStream!({ model, messages: [] } as never, () => {}),
    () => a.decide.decide({ model } as never),
    () => a.embed.embed({ model, input: [] } as never),
    () => a.vision.extract(Buffer.from(''), { model } as never),
    () => a.image.generate({ model, prompt: 'x' } as never),
    () => a.tts.synthesize({ model, text: 'x' } as never),
    () => a.stt.transcribe(Buffer.from(''), { model } as never),
  ];
}

const KEYS = ['MANTLE_POLICY_MODEL_DENY', 'MANTLE_POLICY_PROVIDER_ALLOW'] as const;
const saved: Record<string, string | undefined> = {};
function policy(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  resetBoxPolicyForTests();
}
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  policy({});
  calls = 0;
  h.alerts = [];
  resetModelPolicyAlertThrottleForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBoxPolicyForTests();
});

describe('no model rule', () => {
  it('every capability calls its adapter, auto routers and deepseek included', async () => {
    for (const [provider, model] of [
      ['openrouter', 'openrouter/auto'],
      ['deepseek', 'deepseek-chat'],
    ] as const) {
      for (const call of callsWith(adapters(provider), model)) await call();
    }
    expect(calls).toBe(16);
    expect(h.alerts).toEqual([]);
  });
});

describe('a model rule', () => {
  it('refuses a denied family on every capability before the adapter runs', async () => {
    policy({ MANTLE_POLICY_MODEL_DENY: 'deepseek/*' });
    for (const call of callsWith(adapters('deepseek'), 'deepseek-chat')) {
      await expect(call()).rejects.toBeInstanceOf(ModelPolicyError);
    }
    for (const call of callsWith(adapters('openrouter'), 'deepseek/deepseek-r1')) {
      await expect(call()).rejects.toBeInstanceOf(ModelPolicyError);
    }
    expect(calls).toBe(0);
    // Allowed models still run.
    for (const call of callsWith(adapters('openrouter'), 'anthropic/claude-sonnet-5')) await call();
    expect(calls).toBe(8);
  });

  it('refuses a provider off the allow-list', async () => {
    policy({ MANTLE_POLICY_PROVIDER_ALLOW: 'local' });
    await expect(
      adapters('mammouth').chat.chat({ model: 'gpt-5', messages: [] } as never),
    ).rejects.toBeInstanceOf(ModelPolicyError);
    await adapters('local').chat.chat({ model: 'llama3', messages: [] } as never);
    expect(calls).toBe(1);
  });

  it('refuses an allowed provider pointed at a host off the endpoint list', async () => {
    policy({ MANTLE_POLICY_PROVIDER_ALLOW: 'local' });
    process.env.MANTLE_POLICY_ENDPOINT_ALLOW = 'llm.example.internal';
    resetBoxPolicyForTests();
    try {
      const a = adapters('local');
      await expect(
        a.chat.chat({
          model: 'llama3',
          messages: [],
          baseUrl: 'https://api.vendor.example/v1',
        } as never),
      ).rejects.toBeInstanceOf(ModelPolicyError);
      await expect(
        a.embed.embed({ model: 'e', input: [], baseUrl: 'https://api.vendor.example/v1' } as never),
      ).rejects.toBeInstanceOf(ModelPolicyError);
      await a.chat.chat({
        model: 'llama3',
        messages: [],
        baseUrl: 'http://llm.example.internal/v1',
      } as never);
      await a.chat.chat({ model: 'llama3', messages: [] } as never);
      expect(calls).toBe(2);
    } finally {
      delete process.env.MANTLE_POLICY_ENDPOINT_ALLOW;
      resetBoxPolicyForTests();
    }
  });

  it('a refusal opens the model_policy alert, at most once a minute', async () => {
    policy({ MANTLE_POLICY_MODEL_DENY: 'qwen/*' });
    const a = adapters('openrouter');
    await expect(a.chat.chat({ model: 'qwen/qwen3', messages: [] } as never)).rejects.toThrow();
    await expect(a.chat.chat({ model: 'qwen/qwen3', messages: [] } as never)).rejects.toThrow();
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    const [, subject, failure] = h.alerts[0] as [string, string, Record<string, unknown>];
    expect(subject).toBe('model_policy');
    expect(failure).toMatchObject({
      code: 'policy',
      permanent: true,
      provider: 'openrouter',
      model: 'qwen/qwen3',
    });
  });

  it('the refusal is a clear 403 domain error and a permanent provider class', async () => {
    policy({ MANTLE_POLICY_MODEL_DENY: 'qwen/*' });
    const err = await adapters('openrouter')
      .embed.embed({ model: 'qwen/qwen3-embedding', input: [] } as never)
      .catch((e: unknown) => e);
    const answer = domainErrorAnswer(err);
    expect(answer?.status).toBe(403);
    expect(answer?.body).toMatchObject({ code: 'model_policy', rule: 'model_deny' });
    expect(answer?.toolText).toMatch(/MANTLE_POLICY_MODEL_DENY/);
    expect(classifyProviderError(err)).toMatchObject({ code: 'policy', permanent: true });
  });
});

describe('router ids in the shipped catalogs', () => {
  it('every chat model that picks its model per call is an auto router', async () => {
    const { isAutoRouterModel } = await import('@mantle/config');
    const mods = await Promise.all([
      import('@mantle/voice-client/catalogs/mammouth'),
      import('@mantle/voice-client/catalogs/openrouter'),
      import('@mantle/voice-client/catalogs/copilot'),
      import('@mantle/voice-client/catalogs/huggingface'),
    ]);
    const ids = mods.flatMap((m) =>
      Object.values(m)
        .filter(Array.isArray)
        .flat()
        .map((x) => (x as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string'),
    );
    // A catalog entry whose words say it picks the model is a router.
    const routers = ids.filter((id) => /(^|[/:-])(auto|router|recommended)(-|$)/i.test(id));
    expect(routers).toContain('mammouth-recommended');
    for (const id of routers) expect(isAutoRouterModel(id), id).toBe(true);
  });
});
