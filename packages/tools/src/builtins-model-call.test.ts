/**
 * model_call: one chat request on the brain's own model path, the one way an
 * app or an outside agent calls a model (an http tool may not carry a
 * provider's key: secret-ref-gate.ts). What it sends, what it answers, and
 * its refusals. The cost is the adapter's to record (spend.ts); the trace an
 * app's call lands on is dispatch-spend-trace.test.ts's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '@mantle/std';
import type { ChatOptions } from '@mantle/voice';

const sent: ChatOptions[] = [];
let failWith: Error | null = null;
let key: { apiKey: string } | null = { apiKey: 'test-key' };
let adapterFor: (provider: string) => boolean = (p) => p === 'openrouter' || p === 'anthropic';
const keyAsked: string[] = [];

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProviderKey: vi.fn(async (_owner: string, service: string) => {
    keyAsked.push(service);
    return key;
  }),
}));
vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: (provider: string) =>
    adapterFor(provider)
      ? {
          adapterName: `${provider}-chat`,
          chat: async (opts: ChatOptions) => {
            sent.push(opts);
            if (failWith) throw failWith;
            return {
              text: '{"part":"A-12"}',
              model: opts.model,
              tokensIn: 120,
              tokensOut: 8,
              reportedCostUsd: 0.0012,
            };
          },
        }
      : null,
}));

const { WORKER_DELEGATION_TOOLS } = await import('./builtins-workers');
const modelCall = WORKER_DELEGATION_TOOLS.find((t) => t.slug === 'model_call')!;
const ctx = { ownerId: 'owner-1' } as Parameters<typeof modelCall.handler>[1];

beforeEach(() => {
  sent.length = 0;
  keyAsked.length = 0;
  failWith = null;
  key = { apiKey: 'test-key' };
  adapterFor = (p) => p === 'openrouter' || p === 'anthropic';
});

describe('model_call', () => {
  it('is a spending builtin that a team app never calls', () => {
    expect(modelCall.policy).toMatchObject({
      spends: 'ownerKey',
      startsModelWork: true,
      memberApp: 'refused',
    });
  });

  it('sends the system and the prompt on the OpenRouter key by default, and answers text, tokens and cost', async () => {
    const r = await modelCall.handler(
      { model: 'openai/gpt-6.1-sol', system: 'Part number only.', prompt: 'Which part?' },
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      output: {
        text: '{"part":"A-12"}',
        model: 'openai/gpt-6.1-sol',
        tokens: { in: 120, out: 8 },
        cost_usd: 0.0012,
      },
    });
    expect(keyAsked).toEqual(['openrouter']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      apiKey: 'test-key',
      model: 'openai/gpt-6.1-sol',
      maxTokens: 4000,
      messages: [
        { role: 'system', content: 'Part number only.' },
        { role: 'user', content: 'Which part?' },
      ],
    });
    expect(sent[0]!.thinkingEffort).toBeUndefined();
    expect(sent[0]!.extra).toBeUndefined();
  });

  it('passes max_tokens and a reasoning effort', async () => {
    const r = await modelCall.handler(
      {
        model: 'anthropic/claude-sonnet-5',
        provider: 'anthropic',
        prompt: 'x',
        max_tokens: 900,
        reasoning_effort: 'high',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(keyAsked).toEqual(['anthropic']);
    expect(sent[0]).toMatchObject({
      maxTokens: 900,
      thinkingEffort: 'high',
      messages: [{ role: 'user', content: 'x' }],
    });
  });

  it('drops a reasoning effort it does not know', async () => {
    await modelCall.handler({ model: 'm', prompt: 'x', reasoning_effort: 'turbo' }, ctx);
    expect(sent[0]!.thinkingEffort).toBeUndefined();
  });

  it('refuses a call with no model or no prompt, and sends nothing', async () => {
    const noModel = await modelCall.handler({ prompt: 'x' }, ctx);
    const noPrompt = await modelCall.handler({ model: 'm', prompt: '  ' }, ctx);
    expect(noModel).toMatchObject({
      ok: false,
      error: expect.stringContaining('model is required'),
    });
    expect(noPrompt).toMatchObject({
      ok: false,
      error: expect.stringContaining('prompt is required'),
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses a provider with no chat adapter, and one with no key, naming the fix', async () => {
    const noAdapter = await modelCall.handler(
      { model: 'm', prompt: 'x', provider: 'deepgram' },
      ctx,
    );
    expect(noAdapter).toMatchObject({ ok: false, error: expect.stringContaining("'deepgram'") });
    key = null;
    const noKey = await modelCall.handler({ model: 'm', prompt: 'x' }, ctx);
    expect(noKey).toMatchObject({
      ok: false,
      error: expect.stringContaining('Settings → API keys'),
    });
    expect(sent).toHaveLength(0);
  });

  it("answers a provider's failure with the fixed sentence, never its body", async () => {
    failWith = new ProviderHttpError({
      provider: 'openrouter',
      status: 429,
      body: 'sk-or-v1-secret org=acme',
      message: 'openrouter 429: sk-or-v1-secret org=acme',
    });
    const r = await modelCall.handler({ model: 'm', prompt: 'x' }, ctx);
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toBe('The provider limits the request rate. (openrouter, HTTP 429)');
    expect(error).not.toContain('sk-or');
  });
});
