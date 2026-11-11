/**
 * `leastThinking` on the OpenRouter image read: the request asks for the
 * least reasoning only when the caller sets it (the sketch read of a scanned
 * drawing, whose answer cap a thinking model would fill), and is unchanged
 * otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openrouterVisionAdapter } from './openrouter-vision';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function bodyOf(leastThinking?: boolean): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '1: TK-7' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  await openrouterVisionAdapter.extract(Buffer.from('made-up'), {
    apiKey: 'made-up-key',
    mimeType: 'image/png',
    prompt: 'read it',
    model: 'made/up-model',
    maxTokens: 280,
    ...(leastThinking === undefined ? {} : { leastThinking }),
  });
  return sent;
}

describe('openrouter vision: least thinking', () => {
  it('asks for minimal reasoning when the caller sets it', async () => {
    const body = await bodyOf(true);
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    expect(body.max_tokens).toBe(280);
  });

  it('sends no reasoning setting otherwise', async () => {
    expect((await bodyOf()).reasoning).toBeUndefined();
    expect((await bodyOf(false)).reasoning).toBeUndefined();
  });
});
