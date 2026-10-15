/**
 * A10 #10 fix round 1: a provider's answer can carry an account id, an
 * organisation name or part of a key. A worker tool whose provider call fails
 * answers the fixed sentence for the failure's class (the model reads the
 * tool text, and a member may see it), never the provider's body.
 */
import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '@mantle/std';

const SECRET = 'sk-proj-0123456789abcdef org=acme-private';
const providerError = () =>
  new ProviderHttpError({
    provider: 'openai',
    status: 429,
    body: SECRET,
    message: `openai-image 429: ${SECRET}`,
  });

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultWorker: vi.fn(async (_owner: string, kind: string) => ({
    id: `w-${kind}`,
    slug: `default-${kind}`,
    provider: 'openai',
    model: 'test-model',
    apiKeyId: 'key-1',
    params: {},
    systemPrompt: null,
  })),
}));
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: vi.fn(async () => 'test-key') }));
vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: () => ({
    adapterName: 'stub-chat',
    chat: async () => {
      throw providerError();
    },
  }),
  getImageGenAdapter: () => ({
    adapterName: 'stub-image',
    supports: [],
    generate: async () => {
      throw providerError();
    },
  }),
}));

const { WORKER_DELEGATION_TOOLS } = await import('./builtins-workers');
const tool = (slug: string) => WORKER_DELEGATION_TOOLS.find((t) => t.slug === slug)!;
const ctx = { ownerId: 'owner-1' } as Parameters<ReturnType<typeof tool>['handler']>[1];

describe('worker tools: a provider error is the fixed sentence', () => {
  it('summarize_text', async () => {
    const r = await tool('summarize_text').handler({ text: 'some long text' }, ctx);
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toBe('The provider limits the request rate. (openai, HTTP 429)');
    expect(error).not.toContain('sk-proj');
  });

  it('generate_image', async () => {
    const r = await tool('generate_image').handler({ prompt: 'a house' }, ctx);
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).not.toContain('sk-proj');
    expect(error).not.toContain('acme-private');
    expect(error).toBe('The provider limits the request rate. (openai, HTTP 429)');
  });
});
