/**
 * Several images in one vision request: each image after its caption, in
 * order, in ONE user turn; and a provider that cannot is refused by name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_TIMEOUTS } from '@mantle/std';
import { extractImages, multiImageProvider } from './vision-images';

const recorded = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  recordUsage: (u: Record<string, unknown>) => {
    recorded.push(u);
    return 0;
  },
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  recorded.length = 0;
});

describe('extractImages', () => {
  it('sends every image after its caption in one request', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'google/gemini-pro-x',
          choices: [{ message: { content: '{"answers":[]}' } }],
          usage: { prompt_tokens: 1200, completion_tokens: 40 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const r = await extractImages(
      'openrouter',
      [
        { bytes: Buffer.from('a'), mimeType: 'image/png', caption: 'Image 1' },
        { bytes: Buffer.from('b'), mimeType: 'image/png', caption: 'Image 2' },
      ],
      { apiKey: 'k', mimeType: 'image/png', prompt: 'Answer in JSON.', model: 'm' },
    );
    expect(bodies).toHaveLength(1);
    const content = (bodies[0]!.messages as { content: { type: string; text?: string }[] }[])[0]!
      .content;
    expect(content.map((c) => c.type)).toEqual(['text', 'text', 'image_url', 'text', 'image_url']);
    expect(content[1]!.text).toBe('Image 1');
    expect(r).toEqual({
      text: '{"answers":[]}',
      model: 'google/gemini-pro-x',
      tokensIn: 1200,
      tokensOut: 40,
    });
  });

  it('refuses a provider that cannot take several images', async () => {
    expect(multiImageProvider('openrouter')).toBe(true);
    expect(multiImageProvider('anthropic')).toBe(false);
    await expect(
      extractImages('anthropic', [{ bytes: Buffer.from('a'), mimeType: 'image/png' }], {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
      }),
    ).rejects.toThrow(/cannot take several images/);
  });

  it('caps the reasoning, says why a reply stopped, and has its own time budget', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'google/gemini-pro-x',
          choices: [{ message: { content: '{"answers":[{"id":"q1"' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 900, completion_tokens: 8000 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const r = await extractImages(
      'openrouter',
      [{ bytes: Buffer.from('a'), mimeType: 'image/png' }],
      { apiKey: 'k', mimeType: 'image/png', prompt: 'p', model: 'm', maxTokens: 8000 },
      { reasoningMaxTokens: 4000 },
    );
    expect(bodies[0]).toMatchObject({ max_tokens: 8000, reasoning: { max_tokens: 4000 } });
    expect(r.finishReason).toBe('length');
    // A reply cut off at its token cap was still paid for: its spend is
    // recorded with the tokens it reported (circuit_verify asks its
    // unanswered questions again, never for free).
    expect(recorded).toEqual([
      expect.objectContaining({
        capability: 'vision',
        provider: 'openrouter',
        inputTokens: 900,
        outputTokens: 8000,
      }),
    ]);
    expect(PROVIDER_TIMEOUTS.visionImages).toBeGreaterThanOrEqual(120_000);
    expect(PROVIDER_TIMEOUTS.visionImages).toBeGreaterThan(PROVIDER_TIMEOUTS.vision);
  });

  it('a timed-out request is recorded with no tokens, marked timed out, then thrown', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('provider call timed out after 4m', 'TimeoutError');
    }) as typeof fetch;
    await expect(
      extractImages('openrouter', [{ bytes: Buffer.from('a'), mimeType: 'image/png' }], {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
        model: 'm',
      }),
    ).rejects.toThrow(/timed out/);
    expect(recorded).toEqual([
      expect.objectContaining({
        capability: 'vision',
        provider: 'openrouter',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        timedOut: true,
      }),
    ]);
    // Any other failure records nothing (no attempt billed by its deadline).
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    recorded.length = 0;
    await expect(
      extractImages('openrouter', [{ bytes: Buffer.from('a'), mimeType: 'image/png' }], {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
        model: 'm',
      }),
    ).rejects.toThrow();
    expect(recorded).toEqual([]);
  });
});
