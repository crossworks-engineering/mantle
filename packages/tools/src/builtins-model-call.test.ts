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
              finishReason: 'stop',
            };
          },
        }
      : null,
}));

const { WORKER_DELEGATION_TOOLS, modelCallMessages } = await import('./builtins-workers');
const { validateToolArgs } = await import('./validate-args');
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
        finish_reason: 'stop',
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

  it('sends a chat with pictures as the adapter parts, a system turn as its text', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const r = await modelCall.handler(
      {
        model: 'openai/gpt-6-astra',
        max_tokens: 24000,
        reasoning_effort: 'medium',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Read the drawing.' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Page 3' },
              { type: 'image_url', image_url: { url: png, detail: 'high' } },
              { type: 'image_url', image_url: png },
              { type: 'image_url', imageUrl: { url: png, detail: 'low' } },
            ],
          },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(sent[0]).toMatchObject({
      model: 'openai/gpt-6-astra',
      maxTokens: 24000,
      thinkingEffort: 'medium',
      messages: [
        { role: 'system', content: 'Read the drawing.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Page 3' },
            { type: 'image_url', imageUrl: { url: png, detail: 'high' } },
            { type: 'image_url', imageUrl: { url: png } },
            { type: 'image_url', imageUrl: { url: png, detail: 'low' } },
          ],
        },
      ],
    });
  });

  it('refuses messages together with prompt or system, and sends nothing', async () => {
    const both = await modelCall.handler(
      { model: 'm', prompt: 'x', messages: [{ role: 'user', content: 'y' }] },
      ctx,
    );
    expect(both).toMatchObject({ ok: false, error: expect.stringContaining('not both') });
    expect(sent).toHaveLength(0);
  });
});

describe('modelCallMessages', () => {
  it('refuses a PDF file part, and says to send the page as a picture', () => {
    const r = modelCallMessages([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: { filename: 'p.pdf', file_data: 'data:application/pdf;base64,JVBE' },
          },
        ],
      },
    ]);
    expect(typeof r).toBe('string');
    expect(r).toContain("'file' part");
    expect(r).toContain('as a picture');
  });

  it('refuses a picture that is not a base64 data image: https, other schemes, wrapped base64', () => {
    for (const url of [
      'https://x.test/a.png',
      'http://x.test/a.png',
      'file:///etc/passwd',
      'data:application/pdf;base64,JVBE',
      'DATA:IMAGE/PNG;BASE64,iVBO',
      'data:image/png;base64,iVBO\nRw0K',
    ]) {
      const r = modelCallMessages([
        { role: 'user', content: [{ type: 'image_url', image_url: { url } }] },
      ]);
      expect(r, url).toEqual(expect.stringContaining('data:image/'));
    }
  });

  it('refuses an empty list, another role, and a picture in a system turn', () => {
    expect(modelCallMessages([])).toEqual(expect.stringContaining('non-empty'));
    expect(modelCallMessages([{ role: 'tool', content: 'x' }])).toEqual(
      expect.stringContaining("must be 'system', 'user' or 'assistant'"),
    );
    expect(
      modelCallMessages([
        {
          role: 'system',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } }],
        },
      ]),
    ).toEqual(expect.stringContaining('text only'));
  });

  it('keeps plain string turns as they are, reads developer as system, leaves an unknown detail out', () => {
    expect(
      modelCallMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'developer', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBO', detail: 'ultra' },
            },
          ],
        },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBO' } }],
      },
    ]);
  });

  it('refuses an empty text part, with its place', () => {
    expect(modelCallMessages([{ role: 'user', content: [{ type: 'text', text: '' }] }])).toEqual(
      expect.stringContaining('messages[0].content[0] is a text part with no text'),
    );
  });
});

describe('model_call schema', () => {
  it('lets a real packet through the arg validator untouched', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const input = {
      model: 'openai/gpt-6-astra',
      max_tokens: 24000,
      reasoning_effort: 'medium',
      messages: [
        { role: 'system', content: 'Read the drawing.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Page 3' },
            { type: 'image_url', image_url: { url: png, detail: 'high' } },
          ],
        },
      ],
    };
    const r = validateToolArgs(
      modelCall.inputSchema as Record<string, unknown>,
      input,
      'model_call',
    );
    expect(r.error).toBeNull();
    expect(r.violations).toEqual([]);
    expect(r.repairs).toEqual([]);
    expect(r.input).toEqual(input);
  });
});
