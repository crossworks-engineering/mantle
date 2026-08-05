/**
 * google-chat thinking: the depth knob, and what a thinking turn costs.
 *
 * Two findings from reading @ai-sdk/google's capability table against ours,
 * both invisible at runtime because neither fails loudly:
 *
 *   1. **Gemini 3 replaced `thinkingBudget` with `thinkingLevel`.** The old
 *      field is still accepted there for backwards compatibility, so no request
 *      ever 400'd — Google documents it as producing "unexpected performance"
 *      on Gemini 3 Pro instead. Sending BOTH knobs IS a 400, so the two are
 *      pinned here as mutually exclusive rather than merely "the right one is
 *      present".
 *
 *   2. **Thinking tokens are billed but were not counted.** Gemini reports
 *      `thoughtsTokenCount` separately from `candidatesTokenCount`, and prices
 *      the response on the SUM. Reading only the latter under-reported every
 *      thinking turn — usually by more than the visible reply itself.
 *
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking
 */

import { afterEach, describe, expect, it } from 'vitest';
import { googleChatAdapter } from './google-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the serialised request body — assert on what went on the wire, never
 *  on the object we handed the adapter. */
function captureFetch(response: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return { ok: true, json: async () => response };
  }) as unknown as typeof fetch;
  return bodies;
}

const OK = {
  candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: {},
};

const BASE = {
  apiKey: 'gk-test',
  messages: [{ role: 'user' as const, content: 'hi' }],
  thinkingBudget: 4096,
  thinkingEffort: 'medium' as const,
};

type ThinkingConfig = {
  thinkingLevel?: string;
  thinkingBudget?: number;
  includeThoughts?: boolean;
};

const thinkingOf = (body: Record<string, unknown>): ThinkingConfig | undefined =>
  (body.generationConfig as { thinkingConfig?: ThinkingConfig } | undefined)?.thinkingConfig;

describe('google-chat thinking knob per model generation', () => {
  it('sends thinkingLevel (and NOT thinkingBudget) on Gemini 3', async () => {
    const bodies = captureFetch(OK);
    await googleChatAdapter.chat({ ...BASE, model: 'gemini-3.1-pro-preview' });
    const tc = thinkingOf(bodies[0]!);
    expect(tc?.thinkingLevel).toBe('medium');
    expect(tc?.thinkingBudget).toBeUndefined();
    expect(tc?.includeThoughts).toBe(true);
  });

  it('sends thinkingBudget (and NOT thinkingLevel) on Gemini 2.5', async () => {
    const bodies = captureFetch(OK);
    await googleChatAdapter.chat({ ...BASE, model: 'gemini-2.5-flash' });
    const tc = thinkingOf(bodies[0]!);
    expect(tc?.thinkingBudget).toBe(4096);
    expect(tc?.thinkingLevel).toBeUndefined();
  });

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    // Our tiers run one step deeper than Gemini's; both fold into 'high'.
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)('maps effort %s to thinkingLevel %s', async (effort, level) => {
    const bodies = captureFetch(OK);
    await googleChatAdapter.chat({
      ...BASE,
      model: 'gemini-3-flash-preview',
      thinkingEffort: effort,
    });
    expect(thinkingOf(bodies[0]!)?.thinkingLevel).toBe(level);
  });

  it('falls back to thinkingBudget on Gemini 3 when no effort tier was supplied', async () => {
    // Backwards-compatible on purpose: a caller that only sets a budget keeps
    // the behaviour it had, rather than losing thinking altogether.
    const bodies = captureFetch(OK);
    await googleChatAdapter.chat({
      ...BASE,
      model: 'gemini-3.1-flash-lite',
      thinkingEffort: undefined,
    });
    const tc = thinkingOf(bodies[0]!);
    expect(tc?.thinkingBudget).toBe(4096);
    expect(tc?.thinkingLevel).toBeUndefined();
  });

  it('omits thinkingConfig entirely when neither knob is set', async () => {
    const bodies = captureFetch(OK);
    await googleChatAdapter.chat({
      apiKey: 'gk-test',
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(thinkingOf(bodies[0]!)).toBeUndefined();
  });
});

describe('google-chat output tokens include thinking', () => {
  it('sums candidatesTokenCount + thoughtsTokenCount (one-shot)', async () => {
    captureFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 900,
        cachedContentTokenCount: 100,
      },
    });
    const res = await googleChatAdapter.chat({ ...BASE, model: 'gemini-3.1-pro-preview' });
    expect(res.tokensIn).toBe(120);
    // 40 visible + 900 thinking. Reading candidates alone under-reported by 96%.
    expect(res.tokensOut).toBe(940);
    expect(res.cacheReadTokens).toBe(100);
  });

  it('still reports output when only one of the two counters is present', async () => {
    captureFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 11 },
    });
    const res = await googleChatAdapter.chat({ ...BASE, model: 'gemini-2.5-flash' });
    expect(res.tokensOut).toBe(11);
  });

  it('leaves tokensOut undefined when Gemini reported neither counter', async () => {
    // Absent stays absent — a confident zero would read as a free turn.
    captureFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5 },
    });
    const res = await googleChatAdapter.chat({ ...BASE, model: 'gemini-2.5-flash' });
    expect(res.tokensOut).toBeUndefined();
  });

  it('sums both counters on the streaming path too', async () => {
    const frames = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 250 },
      })}\n\n`,
    ];
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await googleChatAdapter.chatStream!(
      { ...BASE, model: 'gemini-3-flash-preview' },
      () => {},
    );
    expect(res.tokensOut).toBe(253);
  });
});
