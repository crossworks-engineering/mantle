/**
 * mammouth-chat wire-shape lock-down.
 *
 * Mammouth is OpenAI-compatible, so message + tool-call translation is covered
 * by the openai-compat suite. This file pins the Mammouth-specific bits:
 *
 *   1. Base URL routing (https://api.mammouth.ai/v1/chat/completions) + Bearer.
 *   2. Cost: `reportedCostUsd` comes from the catalog rate, on BOTH the
 *      one-shot and the streaming path, keyed on the requested id. Undefined
 *      for `mammouth-recommended` and uncatalogued ids, so the trace never
 *      records an invented price.
 *   3. `thinkingBudget` → `reasoning_effort`, with sampling params dropped.
 *   4. Discovery keeps catalogued entries, appends uncatalogued chat ids,
 *      skips embedding/image ids, and soft-fails to the static catalog.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mammouthChatAdapter } from './mammouth-chat';
import { getChatAdapter, isProviderWired } from './index';
import { MAMMOUTH_CHAT_MODELS, mammouthCostUsd } from '../catalogs/mammouth';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, json: async () => response };
  }) as unknown as typeof fetch;
  return calls;
}

function failFetch(status: number) {
  globalThis.fetch = (async () => ({
    ok: false,
    status,
    headers: new Headers(),
    text: async () => 'nope',
  })) as unknown as typeof fetch;
}

function streamFetch(frames: string[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

const reply = (
  model: string,
  usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
) => ({
  model,
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage,
});

describe('mammouth-chat registration', () => {
  it('is registered and wired for chat', () => {
    expect(getChatAdapter('mammouth')?.adapterName).toBe('mammouth-chat');
    expect(isProviderWired('mammouth', 'chat')).toBe(true);
  });
});

describe('mammouth-chat routing + auth', () => {
  it('POSTs to https://api.mammouth.ai/v1/chat/completions with Bearer auth', async () => {
    const calls = captureFetch(reply('gpt-5.4'));
    await mammouthChatAdapter.chat({
      apiKey: 'mm-test-key',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('https://api.mammouth.ai/v1/chat/completions');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mm-test-key');
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.model).toBe('gpt-5.4');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('throws a ChatHttpError tagged mammouth on a non-OK response', async () => {
    failFetch(401);
    await expect(
      mammouthChatAdapter.chat({
        apiKey: 'bad',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ provider: 'mammouth', status: 401 });
  });
});

describe('mammouth-chat cost', () => {
  it('prices a catalogued model from the catalog rate (gpt-5.4: $2.50 in / $15 out per 1M)', async () => {
    captureFetch(reply('gpt-5.4'));
    const r = await mammouthChatAdapter.chat({
      apiKey: 'k',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.tokensIn).toBe(1_000_000);
    expect(r.tokensOut).toBe(100_000);
    expect(r.reportedCostUsd).toBeCloseTo(2.5 + 1.5, 6);
  });

  it('keys cost on the requested id even when the response names a dated id', async () => {
    captureFetch(reply('claude-haiku-4-5-20251001'));
    const r = await mammouthChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.reportedCostUsd).toBeCloseTo(1 + 0.5, 6);
  });

  it('leaves cost undefined for mammouth-recommended and uncatalogued ids', async () => {
    for (const model of ['mammouth-recommended', 'brand-new-model']) {
      captureFetch(reply(model));
      const r = await mammouthChatAdapter.chat({
        apiKey: 'k',
        model,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.reportedCostUsd, model).toBeUndefined();
    }
  });

  it('leaves cost undefined when the provider reports no usage', () => {
    expect(mammouthCostUsd('gpt-5.4', undefined, undefined)).toBeUndefined();
  });

  it('prices the streaming path too (the responder path)', async () => {
    const calls = streamFetch([
      sse({ model: 'glm-5.3-flash', choices: [{ delta: { content: 'Hel' } }] }),
      sse({ choices: [{ delta: { content: 'lo' } }] }),
      sse({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
      'data: [DONE]\n\n',
    ]);
    const r = await mammouthChatAdapter.chatStream!(
      { apiKey: 'k', model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );
    expect(calls[0]!.url).toBe('https://api.mammouth.ai/v1/chat/completions');
    expect(r.text).toBe('Hello');
    // glm-5.3-flash: $0.15 in / $0.50 out per 1M.
    expect(r.reportedCostUsd).toBeCloseTo(0.3 + 0.5, 6);
  });
});

describe('mammouth-chat reasoning', () => {
  it('maps thinkingBudget to reasoning_effort and drops sampling params', async () => {
    const calls = captureFetch(reply('claude-sonnet-5'));
    await mammouthChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinkingBudget: 4000,
      temperature: 0.5,
      topP: 0.9,
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('sends reasoning_effort on the streaming path', async () => {
    const calls = streamFetch(['data: [DONE]\n\n']);
    await mammouthChatAdapter.chatStream!(
      {
        apiKey: 'k',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingBudget: 10_000,
      },
      () => {},
    );
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBe('high');
  });
});

describe('mammouth-chat discovery', () => {
  it('keeps catalogued models, appends new chat ids, skips embedding/image ids', async () => {
    captureFetch({
      data: [
        { id: 'gpt-5.4' },
        { id: 'claude-haiku-4-5' },
        { id: 'brand-new-model' },
        { id: 'text-embedding-3-small' },
        { id: 'gemini-3.1-flash-image-preview' },
      ],
    });
    const res = await mammouthChatAdapter.discoverModels!('k');
    expect(res.filtered).toBe(true);
    expect(res.error).toBeNull();
    expect(res.available.map((m) => m.id)).toEqual([
      'claude-haiku-4-5',
      'gpt-5.4',
      'brand-new-model',
    ]);
    // liveIds is the raw list, for the models-drift report.
    expect(res.liveIds).toContain('text-embedding-3-small');
  });

  it('soft-fails to the static catalog with no liveIds', async () => {
    failFetch(401);
    const res = await mammouthChatAdapter.discoverModels!('bad');
    expect(res.filtered).toBe(false);
    expect(res.liveIds).toBeUndefined();
    expect(res.available.length).toBe(MAMMOUTH_CHAT_MODELS.length);
  });
});

describe('mammouth catalog', () => {
  it('has unique ids, each with a label and description', () => {
    const ids = MAMMOUTH_CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MAMMOUTH_CHAT_MODELS) {
      expect(m.label.length, m.id).toBeGreaterThan(0);
      expect(m.description.length, m.id).toBeGreaterThan(0);
    }
  });
});
