/**
 * Several images in one vision request: each image after its caption, in
 * order, in ONE user turn; and a provider that cannot is refused by name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_TIMEOUTS } from '@mantle/std';
import { extractImages, multiImageProvider } from './vision-images';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
    expect(PROVIDER_TIMEOUTS.visionImages).toBeGreaterThanOrEqual(120_000);
    expect(PROVIDER_TIMEOUTS.visionImages).toBeGreaterThan(PROVIDER_TIMEOUTS.vision);
  });
});
