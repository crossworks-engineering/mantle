/**
 * The vision-worker save gate. Two silent failures it must catch: an id that
 * does not exist (the 2026-08-31 incident) and an id that exists but does the
 * wrong job — an image GENERATOR on a vision worker, which accepts the image,
 * bills image-generation tokens, and returns a picture the extractor reads as
 * empty text.
 */
import { describe, expect, it, vi } from 'vitest';

const catalog: Record<string, { input: string[]; output: string[] }> = {
  'anthropic/claude-opus-5': { input: ['text', 'image', 'file'], output: ['text'] },
  'google/gemini-3-pro-image': { input: ['image', 'text'], output: ['image', 'text'] },
  'openrouter/auto': { input: ['text', 'image'], output: ['text', 'image'] },
  'deepseek/deepseek-chat': { input: ['text'], output: ['text'] },
};

vi.mock('@mantle/tracing', () => ({
  refreshModelCatalog: async () => {},
  catalogHasModel: (id: string) => id in catalog,
  catalogModalities: (id: string) => catalog[id] ?? null,
  catalogSuggestions: () => [],
}));

vi.mock('@mantle/db', () => ({
  db: {},
  aiWorkers: {},
  getDefaultWorker: () => null,
  bumpWorkerUsage: () => null,
}));

const { openRouterModelIssue } = await import('./ai-workers');

const check = (kind: string, model: string) =>
  openRouterModelIssue({ kind, provider: 'openrouter', model });

describe('openRouterModelIssue', () => {
  it('rejects an image generator on a vision worker', async () => {
    await expect(check('vision', 'google/gemini-3-pro-image')).resolves.toMatch(/OUTPUTS images/);
  });

  it('rejects an image generator on a text worker too', async () => {
    await expect(check('summarizer', 'google/gemini-3-pro-image')).resolves.toMatch(
      /OUTPUTS images/,
    );
  });

  it('rejects a blind model on a vision worker', async () => {
    await expect(check('vision', 'deepseek/deepseek-chat')).resolves.toMatch(
      /does not accept image input/,
    );
  });

  it('allows a real image reader', async () => {
    await expect(check('vision', 'anthropic/claude-opus-5')).resolves.toBeNull();
  });

  it('exempts the meta-router, whose modalities are a union over its routes', async () => {
    await expect(check('summarizer', 'openrouter/auto')).resolves.toBeNull();
  });

  it('still catches an id that does not exist at all', async () => {
    await expect(check('vision', 'anthropic/claude-opus-9')).resolves.toMatch(/not in OpenRouter/);
  });

  it('ignores non-openrouter providers and non-catalog kinds', async () => {
    await expect(
      openRouterModelIssue({ kind: 'vision', provider: 'anthropic', model: 'claude-opus-5' }),
    ).resolves.toBeNull();
    await expect(check('tts', 'google/gemini-3-pro-image')).resolves.toBeNull();
  });
});
