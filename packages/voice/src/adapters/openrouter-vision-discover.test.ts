/**
 * The vision dropdown must offer image READERS only. Filtering on image
 * INPUT alone also matched every image GENERATOR (they take an image in
 * too), which is how Nano Banana Pro reached the "Read images" list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openrouterVisionAdapter } from './openrouter-vision';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
    },
    {
      id: 'google/gemini-3-pro-image',
      name: 'Nano Banana Pro',
      architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] },
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] },
    },
    {
      id: 'deepseek/deepseek-chat',
      name: 'DeepSeek Chat',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ],
};

function stubCatalog() {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => CATALOG,
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('openrouter vision discovery', () => {
  it('offers text-out multimodal models and drops generators and routers', async () => {
    stubCatalog();
    const res = await openrouterVisionAdapter.discoverModels!('sk-or-test');
    const ids = res.available.map((m) => m.id);
    expect(ids).toEqual(['anthropic/claude-opus-5']);
    expect(res.filtered).toBe(true);
  });

  it('falls back to the static catalog when the live list yields nothing', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const res = await openrouterVisionAdapter.discoverModels!('sk-or-test');
    expect(res.available.length).toBeGreaterThan(0);
    expect(res.filtered).toBe(false);
  });
});
