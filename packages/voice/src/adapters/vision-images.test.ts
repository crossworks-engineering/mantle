/**
 * Several images in one vision request: each image after its caption, in
 * order, in ONE user turn; and a provider that cannot is refused by name.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
});
