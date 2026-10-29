/**
 * foundry-chat wire-shape lock-down (docs/foundry.md).
 *
 * The fixtures below are shaped on the Azure OpenAI v1 OpenAPI file
 * (azure-rest-api-specs, specification/ai/data-plane/OpenAI.v1) and the
 * Microsoft Learn examples: the error envelope, the empty-choices first
 * stream chunk with `prompt_filter_results`, the 429 headers. No live
 * resource was reachable from the build machine; docs/foundry.md has the
 * manual smoke steps.
 *
 * Pinned here:
 *   1. Routing: endpoint forms, the route Base URL over MANTLE_FOUNDRY_ENDPOINT,
 *      the v1 route vs the dated per-deployment route, `api-key` auth only.
 *   2. Streaming: the empty first chunk, text, tool-call fragments, usage.
 *   3. Errors: 429 retried with `retry-after-ms`, 404 not retried, 401 and
 *      the content filter in fixed words, config errors that never echo.
 *   4. Reasoning: `max_completion_tokens` with thinking on; the one resend
 *      when a 400 names a refused parameter.
 *   5. Discovery and the environment key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyProviderError,
  isAccountError,
  providerRequestReason,
  PROVIDER_REQUEST_REASONS,
  publicProviderErrorMessage,
} from '@mantle/std';
import { foundryChatAdapter, paramFix } from './foundry-chat';
import { getChatAdapter, isProviderWired } from './index';
import { ChatHttpError } from './retry';
import {
  FOUNDRY_CHAT_MODELS,
  foundryChatUrl,
  foundryResourceRoot,
  parseFoundryApiVersion,
} from '../catalogs/foundry';
import type { ChatOptions } from './types';

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const ROOT = 'https://res-example.openai.azure.com';

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubEnv('MANTLE_FOUNDRY_ENDPOINT', ROOT);
  vi.stubEnv('MANTLE_FOUNDRY_API_VERSION', '');
  vi.stubEnv('MANTLE_FOUNDRY_API_KEY', '');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

// ── fixtures (the documented v1 shapes) ────────────────────────────

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1761700000,
  model: 'gpt-4o-mini-2024-07-18',
  prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }],
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello there.' },
      content_filter_results: {},
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

const TOOL_COMPLETION = {
  ...COMPLETION,
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
          },
        ],
      },
    },
  ],
};

/** The stream as Azure sends it: an empty-choices chunk carrying only the
 *  prompt filter results, then the deltas, then usage, then [DONE]. */
const STREAM_TEXT = [
  { choices: [], prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }] },
  { model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { role: 'assistant' } }] },
  { model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { content: 'Hel' } }] },
  { model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { content: 'lo.' } }] },
  {
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop', content_filter_results: {} }],
  },
  {
    model: 'gpt-4o-mini-2024-07-18',
    choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
  },
];

const STREAM_TOOL = [
  { choices: [], prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }] },
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_xyz',
              type: 'function',
              function: { name: 'get_time', arguments: '' },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz"' } }] } },
    ],
  },
  {
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"UTC"}' } }] } },
    ],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
];

const err = (code: string, message: string) => JSON.stringify({ error: { code, message } });
const ERR_404 = err(
  'DeploymentNotFound',
  'The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.',
);
const ERR_401 = err(
  '401',
  'Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource.',
);
const ERR_429 = err(
  '429',
  'Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 1 second. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.',
);
const ERR_FILTER = JSON.stringify({
  error: {
    code: 'content_filter',
    message:
      "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    param: 'prompt',
    status: 400,
    innererror: { code: 'ResponsibleAIPolicyViolation' },
  },
});
const ERR_MAX_TOKENS = err(
  'unsupported_parameter',
  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
);
const ERR_TEMPERATURE = err(
  'unsupported_value',
  "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
);

// ── fetch doubles ──────────────────────────────────────────────────

type Call = { url: string; init: RequestInit | undefined };

type Answer =
  | { kind: 'json'; body: unknown }
  | { kind: 'sse'; chunks: unknown[] }
  | { kind: 'error'; status: number; body: string; headers?: Record<string, string> };

/** A fetch that answers each call with the next scripted answer (the last
 *  one repeats), recording what was sent. */
function scriptFetch(...answers: Answer[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a.kind === 'error') {
      return new Response(a.body, { status: a.status, headers: a.headers ?? {} });
    }
    if (a.kind === 'json') {
      return new Response(JSON.stringify(a.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const text =
      a.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return calls;
}

const base = (over: Partial<ChatOptions> = {}): ChatOptions => ({
  apiKey: KEY,
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

const bodyOf = (c: Call) => JSON.parse(String(c.init?.body)) as Record<string, unknown>;
const headersOf = (c: Call) => (c.init?.headers ?? {}) as Record<string, string>;

// ── 1. registration + catalog ──────────────────────────────────────

describe('foundry-chat registration', () => {
  it('is registered and wired for chat', () => {
    expect(getChatAdapter('foundry')?.adapterName).toBe('foundry-chat');
    expect(isProviderWired('foundry', 'chat')).toBe(true);
  });

  it('keeps envCredential through the retry and spend wrappers', () => {
    expect(typeof getChatAdapter('foundry')?.envCredential).toBe('function');
  });

  it('has a seed with unique ids, each with a label and description, and no prices', () => {
    const ids = FOUNDRY_CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of FOUNDRY_CHAT_MODELS) {
      expect(m.label.length, m.id).toBeGreaterThan(0);
      expect(m.description.length, m.id).toBeGreaterThan(0);
      expect(m.inputPricePer1M, m.id).toBeUndefined();
    }
  });
});

// ── 2. routing ─────────────────────────────────────────────────────

describe('foundry endpoint rules', () => {
  it.each([
    ['https://res.openai.azure.com', 'https://res.openai.azure.com'],
    ['https://res.openai.azure.com/', 'https://res.openai.azure.com'],
    ['https://res.openai.azure.com/openai/v1/', 'https://res.openai.azure.com'],
    ['https://res.services.ai.azure.com/openai', 'https://res.services.ai.azure.com'],
    ['  https://gw.example.com/aoai/openai/v1  ', 'https://gw.example.com/aoai'],
  ])('reduces %s to its resource root', (input, root) => {
    expect(foundryResourceRoot(input)).toBe(root);
  });

  it.each([
    'http://res.openai.azure.com',
    'https://user:pass@res.openai.azure.com',
    'https://res.openai.azure.com/?api-key=x',
    'https://res.openai.azure.com/#x',
    'res.openai.azure.com',
    '',
  ])('refuses %j', (input) => {
    expect(foundryResourceRoot(input)).toBeNull();
  });

  it('parses the API versions it knows and nothing else', () => {
    expect(parseFoundryApiVersion(undefined)).toEqual({ kind: 'v1', query: null });
    expect(parseFoundryApiVersion('v1')).toEqual({ kind: 'v1', query: null });
    expect(parseFoundryApiVersion('preview')).toEqual({ kind: 'v1', query: 'preview' });
    expect(parseFoundryApiVersion('2024-10-21')).toEqual({ kind: 'dated', query: '2024-10-21' });
    expect(parseFoundryApiVersion('2025-04-01-preview')).toEqual({
      kind: 'dated',
      query: '2025-04-01-preview',
    });
    expect(parseFoundryApiVersion('2024-10-21&x=1')).toBeNull();
    expect(parseFoundryApiVersion('latest')).toBeNull();
  });

  it('puts the deployment in the path, encoded, on the dated route', () => {
    expect(foundryChatUrl(ROOT, 'my dep/1', { kind: 'dated', query: '2024-10-21' })).toBe(
      `${ROOT}/openai/deployments/my%20dep%2F1/chat/completions?api-version=2024-10-21`,
    );
  });
});

describe('foundry-chat routing + auth', () => {
  it('POSTs to <resource>/openai/v1/chat/completions with the api-key header only', async () => {
    const calls = scriptFetch({ kind: 'json', body: COMPLETION });
    await foundryChatAdapter.chat(base({ model: 'my-gpt4o-mini' }));
    expect(calls[0]!.url).toBe(`${ROOT}/openai/v1/chat/completions`);
    const h = headersOf(calls[0]!);
    expect(h['api-key']).toBe(KEY);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
    // The model sent is the DEPLOYMENT name, as given.
    expect(bodyOf(calls[0]!).model).toBe('my-gpt4o-mini');
  });

  it('uses the route Base URL over MANTLE_FOUNDRY_ENDPOINT', async () => {
    const calls = scriptFetch({ kind: 'json', body: COMPLETION });
    await foundryChatAdapter.chat(
      base({ baseUrl: 'https://other.services.ai.azure.com/openai/v1' }),
    );
    expect(calls[0]!.url).toBe('https://other.services.ai.azure.com/openai/v1/chat/completions');
  });

  it('adds ?api-version=preview for the preview version', async () => {
    vi.stubEnv('MANTLE_FOUNDRY_API_VERSION', 'preview');
    const calls = scriptFetch({ kind: 'json', body: COMPLETION });
    await foundryChatAdapter.chat(base());
    expect(calls[0]!.url).toBe(`${ROOT}/openai/v1/chat/completions?api-version=preview`);
  });

  it('uses the per-deployment route for a date version, on the stream too', async () => {
    vi.stubEnv('MANTLE_FOUNDRY_API_VERSION', '2024-10-21');
    const calls = scriptFetch({ kind: 'sse', chunks: STREAM_TEXT });
    await foundryChatAdapter.chatStream!(base({ model: 'gpt-4o-mini' }), () => {});
    expect(calls[0]!.url).toBe(
      `${ROOT}/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21`,
    );
  });

  it('refuses a missing or bad endpoint in fixed words that never echo it', async () => {
    const calls = scriptFetch({ kind: 'json', body: COMPLETION });
    vi.stubEnv('MANTLE_FOUNDRY_ENDPOINT', '');
    await expect(foundryChatAdapter.chat(base())).rejects.toThrow(/needs an endpoint/);
    const secretish = 'http://user-secret@internal.example';
    const e = await foundryChatAdapter.chat(base({ baseUrl: secretish })).catch((x) => x);
    expect(String(e.message)).toMatch(/not a plain https URL/);
    expect(String(e.message)).not.toContain('user-secret');
    vi.stubEnv('MANTLE_FOUNDRY_ENDPOINT', ROOT);
    vi.stubEnv('MANTLE_FOUNDRY_API_VERSION', 'bogus');
    await expect(foundryChatAdapter.chat(base())).rejects.toThrow(/MANTLE_FOUNDRY_API_VERSION/);
    expect(calls).toHaveLength(0);
  });

  it('requires a key and a deployment name', async () => {
    await expect(foundryChatAdapter.chat(base({ apiKey: '' }))).rejects.toThrow(/apiKey/);
    await expect(foundryChatAdapter.chat(base({ model: ' ' }))).rejects.toThrow(/deployment/);
  });
});

// ── 3. answers ─────────────────────────────────────────────────────

describe('foundry-chat answers', () => {
  it('maps the one-shot answer: text, model, usage, cache reads, finish reason', async () => {
    scriptFetch({ kind: 'json', body: COMPLETION });
    const r = await foundryChatAdapter.chat(base());
    expect(r).toMatchObject({
      text: 'Hello there.',
      model: 'gpt-4o-mini-2024-07-18',
      tokensIn: 12,
      tokensOut: 3,
      cacheReadTokens: 4,
      finishReason: 'stop',
    });
    expect(r.reportedCostUsd).toBeUndefined();
  });

  it('maps a one-shot tool call, and sends the tools and tool_choice', async () => {
    const calls = scriptFetch({ kind: 'json', body: TOOL_COMPLETION });
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'get_time', description: 'Now', parameters: { type: 'object' } },
      },
    ];
    const r = await foundryChatAdapter.chat(base({ tools, toolChoice: 'auto' }));
    expect(bodyOf(calls[0]!).tools).toEqual(tools);
    expect(bodyOf(calls[0]!).tool_choice).toBe('auto');
    expect(r.toolCalls).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
      },
    ]);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('passes JSON mode through (response_format on opts.extra)', async () => {
    const calls = scriptFetch({ kind: 'json', body: COMPLETION });
    await foundryChatAdapter.chat(base({ extra: { response_format: { type: 'json_object' } } }));
    expect(bodyOf(calls[0]!).response_format).toEqual({ type: 'json_object' });
  });

  it('streams text past the empty first chunk, with usage', async () => {
    const calls = scriptFetch({ kind: 'sse', chunks: STREAM_TEXT });
    const deltas: string[] = [];
    const r = await foundryChatAdapter.chatStream!(base(), (d) => {
      if (d.type === 'text') deltas.push(d.text);
    });
    const body = bodyOf(calls[0]!);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(deltas.join('')).toBe('Hello.');
    expect(r).toMatchObject({ text: 'Hello.', tokensIn: 9, tokensOut: 2, finishReason: 'stop' });
  });

  it('joins streamed tool-call fragments into one call', async () => {
    scriptFetch({ kind: 'sse', chunks: STREAM_TOOL });
    const r = await foundryChatAdapter.chatStream!(base(), () => {});
    expect(r.toolCalls).toEqual([
      {
        id: 'call_xyz',
        type: 'function',
        function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
      },
    ]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.tokensIn).toBe(20);
  });
});

// ── 4. errors ──────────────────────────────────────────────────────

describe('foundry-chat errors', () => {
  it('a 429 is a rate limit with the retry-after-ms wait, retried by the wrapper', async () => {
    const calls = scriptFetch(
      {
        kind: 'error',
        status: 429,
        body: ERR_429,
        headers: { 'retry-after-ms': '5', 'retry-after': '1' },
      },
      { kind: 'json', body: COMPLETION },
    );
    const raw = await foundryChatAdapter.chat(base()).catch((x) => x);
    expect(raw).toBeInstanceOf(ChatHttpError);
    expect(raw.status).toBe(429);
    expect(raw.retryAfterMs).toBe(5);
    expect(classifyProviderError(raw)?.code).toBe('rate_limit');
    expect(isAccountError(raw)).toBe(false);

    calls.length = 0;
    scriptFetch(
      { kind: 'error', status: 429, body: ERR_429, headers: { 'retry-after-ms': '5' } },
      { kind: 'json', body: COMPLETION },
    );
    const r = await getChatAdapter('foundry')!.chat(base());
    expect(r.text).toBe('Hello there.');
  });

  it('a 429 on the stream retries before any output', async () => {
    const calls = scriptFetch(
      { kind: 'error', status: 429, body: ERR_429, headers: { 'retry-after-ms': '5' } },
      { kind: 'sse', chunks: STREAM_TEXT },
    );
    const r = await getChatAdapter('foundry')!.chatStream!(base(), () => {});
    expect(r.text).toBe('Hello.');
    expect(calls).toHaveLength(2);
  });

  it('a 404 (no such deployment) is terminal: one call, a model error, fails over', async () => {
    const calls = scriptFetch({ kind: 'error', status: 404, body: ERR_404 });
    const e = await getChatAdapter('foundry')!
      .chat(base())
      .catch((x) => x);
    expect(calls).toHaveLength(1);
    expect(e.status).toBe(404);
    expect(classifyProviderError(e)).toMatchObject({ code: 'model', permanent: true });
    expect(isAccountError(e)).toBe(true);
  });

  it('a 401 is a refused key, and the public text carries neither key nor body', async () => {
    scriptFetch({ kind: 'error', status: 401, body: ERR_401 });
    const e = await getChatAdapter('foundry')!
      .chat(base())
      .catch((x) => x);
    expect(classifyProviderError(e)?.code).toBe('auth');
    const text = publicProviderErrorMessage(e, 'foundry-test');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('subscription key');
  });

  it("the content filter's 400 reads as a refused input, not a retry", async () => {
    const calls = scriptFetch({ kind: 'error', status: 400, body: ERR_FILTER });
    const e = await getChatAdapter('foundry')!
      .chat(base())
      .catch((x) => x);
    expect(calls).toHaveLength(1);
    expect(classifyProviderError(e)).toBeNull();
    expect(providerRequestReason(400, ERR_FILTER)).toBe(PROVIDER_REQUEST_REASONS.refused);
  });
});

// ── 5. reasoning + parameter fixes ─────────────────────────────────

describe('foundry-chat reasoning models', () => {
  it('thinking on: reasoning_effort + max_completion_tokens, no max_tokens or sampling', async () => {
    const calls = scriptFetch({ kind: 'sse', chunks: STREAM_TEXT });
    await foundryChatAdapter.chatStream!(
      base({ thinkingBudget: 4000, maxTokens: 900, temperature: 0.2, topP: 0.9 }),
      () => {},
    );
    const body = bodyOf(calls[0]!);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.max_completion_tokens).toBe(900);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('thinking off: max_tokens, and one resend with max_completion_tokens when refused', async () => {
    const calls = scriptFetch(
      { kind: 'error', status: 400, body: ERR_MAX_TOKENS },
      { kind: 'json', body: COMPLETION },
    );
    const r = await foundryChatAdapter.chat(base({ maxTokens: 500 }));
    expect(r.text).toBe('Hello there.');
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]!).max_tokens).toBe(500);
    expect(bodyOf(calls[1]!).max_tokens).toBeUndefined();
    expect(bodyOf(calls[1]!).max_completion_tokens).toBe(500);
  });

  it('fixes max_tokens then temperature on the stream, and stops there', async () => {
    const calls = scriptFetch(
      { kind: 'error', status: 400, body: ERR_MAX_TOKENS },
      { kind: 'error', status: 400, body: ERR_TEMPERATURE },
      { kind: 'sse', chunks: STREAM_TEXT },
    );
    const r = await foundryChatAdapter.chatStream!(
      base({ maxTokens: 500, temperature: 0.2 }),
      () => {},
    );
    expect(r.text).toBe('Hello.');
    expect(calls).toHaveLength(3);
    const last = bodyOf(calls[2]!);
    expect(last.max_completion_tokens).toBe(500);
    expect(last.temperature).toBeUndefined();
  });

  it('does not resend for a 400 that names no refused parameter', async () => {
    const calls = scriptFetch({ kind: 'error', status: 400, body: err('bad', 'messages: bad') });
    await expect(foundryChatAdapter.chat(base({ maxTokens: 5 }))).rejects.toBeInstanceOf(
      ChatHttpError,
    );
    expect(calls).toHaveLength(1);
  });

  it('paramFix changes nothing it was not asked to', () => {
    const e = new ChatHttpError({ provider: 'foundry', status: 400, body: ERR_TEMPERATURE });
    expect(paramFix(e, base(), {})).toBeNull(); // no temperature was sent
    const e429 = new ChatHttpError({ provider: 'foundry', status: 429, body: ERR_MAX_TOKENS });
    expect(paramFix(e429, base({ maxTokens: 5 }), {})).toBeNull();
  });
});

// ── 6. discovery + the environment key ─────────────────────────────

describe('foundry-chat discovery', () => {
  it('lists the seed plus the base models the resource reports, with the api-key header', async () => {
    const calls = scriptFetch({
      kind: 'json',
      body: {
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', object: 'model', created: 1, owned_by: 'system' },
          { id: 'gpt-4.1-nano', object: 'model', created: 1, owned_by: 'system' },
          { id: 'text-embedding-3-large', object: 'model', created: 1, owned_by: 'system' },
          { id: 'dall-e-3', object: 'model', created: 1, owned_by: 'system' },
        ],
      },
    });
    const res = await foundryChatAdapter.discoverModels!({ apiKey: KEY });
    expect(calls[0]!.url).toBe(`${ROOT}/openai/v1/models`);
    expect(headersOf(calls[0]!)['api-key']).toBe(KEY);
    expect(res.filtered).toBe(true);
    expect(res.error).toBeNull();
    const ids = res.available.map((m) => m.id);
    expect(ids).toContain('gpt-4.1-nano');
    expect(ids.filter((i) => i === 'gpt-4o-mini')).toHaveLength(1);
    expect(ids).not.toContain('text-embedding-3-large');
    expect(ids).not.toContain('dall-e-3');
    expect(res.liveIds).toBeUndefined();
  });

  it('uses the dated model list for a date version', async () => {
    vi.stubEnv('MANTLE_FOUNDRY_API_VERSION', '2024-10-21');
    const calls = scriptFetch({ kind: 'json', body: { data: [] } });
    await foundryChatAdapter.discoverModels!({ apiKey: KEY });
    expect(calls[0]!.url).toBe(`${ROOT}/openai/models?api-version=2024-10-21`);
  });

  it('a refused key reads in fixed words, never the body', async () => {
    scriptFetch({ kind: 'error', status: 401, body: ERR_401 });
    const res = await foundryChatAdapter.discoverModels!({ apiKey: KEY });
    expect(res.filtered).toBe(false);
    expect(res.error).toMatch(/refused the key \(HTTP 401\)/);
    expect(res.error).not.toContain('subscription');
    expect(res.available.length).toBe(FOUNDRY_CHAT_MODELS.length);
  });

  it('with no endpoint, returns the seed and asks for one, without a call', async () => {
    vi.stubEnv('MANTLE_FOUNDRY_ENDPOINT', '');
    const calls = scriptFetch({ kind: 'json', body: { data: [] } });
    const res = await foundryChatAdapter.discoverModels!({ apiKey: KEY });
    expect(calls).toHaveLength(0);
    expect(res.filtered).toBe(false);
    expect(res.error).toMatch(/needs an endpoint/);
  });
});

describe('foundry-chat environment key', () => {
  it('offers MANTLE_FOUNDRY_API_KEY only with the endpoint set and no route Base URL', () => {
    const envCred = foundryChatAdapter.envCredential!;
    expect(envCred(null)).toBeNull(); // no key set
    vi.stubEnv('MANTLE_FOUNDRY_API_KEY', 'env-key');
    expect(envCred(null)).toEqual({ apiKey: 'env-key' });
    expect(envCred('')).toEqual({ apiKey: 'env-key' });
    expect(envCred('https://elsewhere.example.com')).toBeNull();
    vi.stubEnv('MANTLE_FOUNDRY_ENDPOINT', '');
    expect(envCred(null)).toBeNull();
  });
});
