import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domainErrorAnswer } from './domain-errors';
import { watchDatabaseErrors } from './db-watch';
import {
  InputError,
  errorDetail,
  maskKeyLiterals,
  errorMessage,
  personProviderErrorMessage,
  publicErrorText,
  publicProviderErrorMessage,
  publicToolError,
  toolThrowText,
} from './index';
import {
  PROVIDER_REQUEST_REASONS,
  ProviderHttpError,
  UNREADABLE_ANSWER_PUBLIC,
  classifyProviderError,
  isProviderHttpFailure,
  isRouteDownError,
  retryDecision,
} from './provider-error';

describe('ProviderHttpError', () => {
  it('carries status, provider, Retry-After and body, and names its kind', () => {
    const e = new ProviderHttpError({
      provider: 'openai',
      status: 429,
      body: '{"error":{"type":"insufficient_quota"}}',
      retryAfterMs: 2_000,
      what: 'embeddings',
    });
    expect(e.message).toBe('openai embeddings 429: {"error":{"type":"insufficient_quota"}}');
    expect(e.kind).toBe('quota');
    expect(new ProviderHttpError({ provider: 'p', status: 503 }).kind).toBe('server');
    expect(new ProviderHttpError({ provider: 'p', status: 418 }).kind).toBeNull();
  });

  it('keeps an adapter message as given', () => {
    const e = new ProviderHttpError({ provider: 'p', status: 500, message: 'p failed: 500 x' });
    expect(e.message).toBe('p failed: 500 x');
  });

  it('answers a reply with fixed text, never the provider body', () => {
    const secret = 'org-12345 sk-abcd';
    const a = domainErrorAnswer(
      new ProviderHttpError({ provider: 'anthropic', status: 429, body: secret }),
    );
    expect(a?.status).toBe(502);
    expect(a?.toolText).toBe('The provider limits the request rate. (anthropic, HTTP 429)');
    expect(JSON.stringify(a)).not.toContain('org-12345');
    expect(domainErrorAnswer(new ProviderHttpError({ provider: 'x', status: 408 }))?.status).toBe(
      504,
    );
    const wrapped = new Error('turn failed', {
      cause: new ProviderHttpError({ provider: 'x', status: 418, body: secret }),
    });
    expect(domainErrorAnswer(wrapped)?.toolText).toBe(
      'The model provider answered with an error. (x, HTTP 418)',
    );
  });
});

describe('the three readers share one status reading', () => {
  it('read a structured status and the adapters message prefix alike', () => {
    const structured = new ProviderHttpError({ provider: 'o', status: 502 });
    const prose = new Error('OpenAI embeddings failed: 502 Bad Gateway');
    for (const e of [structured, prose]) {
      expect(classifyProviderError(e)?.code).toBe('server');
      expect(isRouteDownError(e)).toBe(true);
    }
    expect(retryDecision(structured).retry).toBe(true);
  });

  it('keep their own edges: 501 fails over but is no chat retry; 409 is a chat retry only', () => {
    const e501 = new ProviderHttpError({ provider: 'o', status: 501 });
    expect(isRouteDownError(e501)).toBe(true);
    expect(retryDecision(e501).retry).toBe(false);
    const e409 = new ProviderHttpError({ provider: 'o', status: 409 });
    expect(retryDecision(e409).retry).toBe(true);
    expect(isRouteDownError(e409)).toBe(false);
    expect(classifyProviderError(e409)).toBeNull();
  });
});

describe('publicProviderErrorMessage (A10 #10 fix round 1)', () => {
  const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';

  it('a ProviderHttpError says its fixed sentence, never the body', () => {
    const e = new ProviderHttpError({ provider: 'deepgram', status: 401, body: SECRET });
    const text = publicProviderErrorMessage(e, 'test');
    expect(text).toBe('The provider refused the API key. (deepgram, HTTP 401)');
    expect(text).not.toContain('sk-or-v1');
  });

  it("an SDK's own error the classifier names (the OpenRouter wrap) says its class", () => {
    const e = new Error(`openrouter-chat 403 on some/model: Forbidden metadata=${SECRET}`);
    const text = publicProviderErrorMessage(e, 'test');
    expect(text).toBe('The provider refused the API key. (HTTP 403)');
    expect(text).not.toContain('acme-private');
  });

  it('anything else keeps its own message (our own errors stay useful)', () => {
    const e = new Error('team turn: no api_key_id on agent x');
    expect(publicProviderErrorMessage(e, 'test')).toBe('team turn: no api_key_id on agent x');
  });
});

describe('a provider failure the classifier does not name (A10 #10 fix round 2)', () => {
  const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';
  let logged: unknown[][] = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** The OpenRouter SDK's error as the chat adapter wraps it (openrouter-chat.ts). */
  const sdkError = (status: number, upstream: string) => {
    const inner = Object.assign(new Error('Provider returned error'), {
      statusCode: status,
      body: JSON.stringify({ error: { message: upstream, metadata: { raw: SECRET } } }),
    });
    return new Error(`openrouter-chat ${status} on some/model: ${upstream} metadata=${SECRET}`, {
      cause: inner,
    });
  };

  it.each([
    [400, 'prompt is too long for this route', PROVIDER_REQUEST_REASONS.too_long],
    [403, 'Your input was flagged by moderation', PROVIDER_REQUEST_REASONS.refused],
    [413, 'Request entity too large', PROVIDER_REQUEST_REASONS.too_long],
    // A10 lows fix round 1, L1: a tool definition is the request's own
    // shape, ours to fix: the neutral sentence, never "check the arguments".
    [400, 'tools.0.function.parameters is invalid', PROVIDER_REQUEST_REASONS.rejected],
    [400, "'size' must be one of 256x256, 1024x1024", PROVIDER_REQUEST_REASONS.bad_request],
    [422, 'unprocessable', PROVIDER_REQUEST_REASONS.rejected],
    [418, 'I am a teapot', 'The model provider answered with an error.'],
  ])(
    'an OpenRouter %i says a fixed sentence and its status, never the body',
    (status, up, says) => {
      const e = sdkError(status, up);
      expect(classifyProviderError(e)).toBeNull();
      const text = publicProviderErrorMessage(e, 'team-turn');
      // A10 lows item 2: the sentence names what the model can fix.
      expect(text).toBe(`${says} (HTTP ${status})`);
      expect(text).not.toContain('acme-private');
      expect(text).not.toContain(up);
      // The detail is in the server log.
      expect(JSON.stringify(logged.map((a) => String(a[1])))).toContain('acme-private');
    },
  );

  it("the SDK's own error, unwrapped (a research tool), is the same", () => {
    const e = Object.assign(new Error(`API error occurred: ${SECRET}`), {
      statusCode: 413,
      body: SECRET,
    });
    expect(publicProviderErrorMessage(e, 'search')).toBe(
      `${PROVIDER_REQUEST_REASONS.too_long} (HTTP 413)`,
    );
  });

  it('a body that did not parse says a fixed sentence (V8 quotes the body)', () => {
    let parseError: unknown;
    try {
      JSON.parse(`<html>${SECRET}</html>`);
    } catch (e) {
      parseError = e;
    }
    const text = publicProviderErrorMessage(parseError, 'test');
    // A10 lows item 1: it no longer blames the model provider.
    expect(text).toBe(UNREADABLE_ANSWER_PUBLIC);
  });
});

describe('a refused key is logged by provider and status only (model picker fix round 1, L2)', () => {
  const SECRET = 'sk-ant-api03-0123456789abcdef org=acme-private';
  let logged: unknown[][] = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([401, 403])('a ProviderHttpError %i never logs its body', (status) => {
    const e = new ProviderHttpError({
      provider: 'anthropic',
      status,
      body: SECRET,
      what: 'models',
    });
    expect(publicProviderErrorMessage(e, 'model-explorer anthropic')).toBe(
      `The provider refused the API key. (anthropic, HTTP ${status})`,
    );
    expect(logged).toEqual([
      [`[model-explorer anthropic] failed: anthropic refused the key (HTTP ${status})`],
    ]);
  });

  it("an SDK's own 401 never logs its body either", () => {
    const e = Object.assign(new Error(`API error occurred: ${SECRET}`), {
      statusCode: 401,
      body: SECRET,
    });
    publicProviderErrorMessage(e, 'search');
    expect(JSON.stringify(logged)).not.toContain('acme-private');
    expect(logged).toEqual([['[search] failed: provider refused the key (HTTP 401)']]);
  });

  it('any other status keeps the full error in the log', () => {
    const e = new ProviderHttpError({ provider: 'anthropic', status: 500, body: SECRET });
    publicProviderErrorMessage(e, 't');
    expect(logged[0]![1]).toBe(e);
  });
});

describe('toolThrowText: a builtin that throws (A10 #10 fix round 2)', () => {
  const text = (e: unknown, where = 't') => toolThrowText(e, where) ?? errorMessage(e);
  const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a person never hears "check the arguments" (fix round 1, L1)', () => {
    const e = new ProviderHttpError({
      provider: 'openai',
      status: 400,
      body: `Invalid value for 'size': must be one of 256x256 ${SECRET}`,
    });
    expect(publicProviderErrorMessage(e, 'generate_image')).toBe(
      `${PROVIDER_REQUEST_REASONS.bad_request} (openai, HTTP 400)`,
    );
    expect(personProviderErrorMessage(e, 'team-turn')).toBe(
      'The model provider refused the request. (openai, HTTP 400)',
    );
    // Every other sentence is the model's.
    const big = new ProviderHttpError({ provider: 'openai', status: 413, body: SECRET });
    expect(personProviderErrorMessage(big, 'team-turn')).toBe(
      publicProviderErrorMessage(big, 'team-turn'),
    );
    // A 400 over the request's own shape, whatever its words: neutral.
    const shape = new ProviderHttpError({
      provider: 'anthropic',
      status: 400,
      body: 'max_tokens: 100000 > 64000, which is the maximum allowed; parameter max_tokens',
    });
    expect(publicProviderErrorMessage(shape, 't')).toBe(
      `${PROVIDER_REQUEST_REASONS.rejected} (anthropic, HTTP 400)`,
    );
  });

  it('a ProviderHttpError says its fixed sentence', () => {
    const e = new ProviderHttpError({ provider: 'openai', status: 500, body: SECRET });
    expect(isProviderHttpFailure(e)).toBe(true);
    expect(text(e, 'tool read_result')).toBe(
      'The provider has a server problem. (openai, HTTP 500)',
    );
  });

  it('a wrapped SDK error says the fixed sentence', () => {
    const inner = Object.assign(new Error('Provider returned error'), {
      statusCode: 400,
      body: SECRET,
    });
    const e = new Error(`openrouter-chat 400 on m: bad ${SECRET}`, { cause: inner });
    expect(text(e, 'tool x')).toBe(`${PROVIDER_REQUEST_REASONS.rejected} (HTTP 400)`);
  });

  it('our own errors keep their text, as on main', () => {
    // Null for anything not a provider's or a domain error: the dispatcher
    // keeps its own errorMessage (which collects a database error).
    expect(toolThrowText(new Error('page not found: abc'), 't')).toBeNull();
    expect(text(new InputError('entry_date must be a valid date'), 't')).toBe(
      'entry_date must be a valid date',
    );
    expect(text(new Error('page not found: abc'), 't')).toBe('page not found: abc');
    // A non-provider fetch's status in our own words is no provider failure.
    expect(text(new Error('fetch failed: 404 Not Found'), 't')).toBe('fetch failed: 404 Not Found');
    // An error with a status but no body (a Graph error) is ours too.
    const graph = Object.assign(new Error('no valid access token'), { status: 401 });
    expect(text(graph, 't')).toBe('no valid access token');
    expect(text(new TypeError("Cannot read properties of undefined (reading 'x')"), 't')).toBe(
      "Cannot read properties of undefined (reading 'x')",
    );
  });
});

describe('an Anthropic key that names no workspace', () => {
  // The shape Anthropic answers; the sentence is theirs and may change, so
  // the classifier reads only the error type and the header name.
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.',
    },
  });

  it('is its own permanent class with a fixed sentence', () => {
    const e = new ProviderHttpError({ provider: 'anthropic', status: 400, body, what: 'chat' });
    const cls = classifyProviderError(e);
    expect(cls?.code).toBe('workspace');
    expect(cls?.permanent).toBe(true);
    expect(cls?.reason).toBe(
      'This Anthropic key is not tied to a workspace. Add or check the workspace id on the key, or use a key made inside an Anthropic workspace.',
    );
    expect(domainErrorAnswer(e)?.toolText).toBe(`${cls?.reason} (anthropic, HTTP 400)`);
  });

  it('reads the same from the message when the body rides in it', () => {
    const e = new Error(`anthropic chat 400: ${body}`);
    expect(classifyProviderError(e)?.code).toBe('workspace');
  });

  it('needs both the error type and the header name', () => {
    const noHeader = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'workspace is archived' },
    });
    const otherType = JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'anthropic-workspace-id names no workspace' },
    });
    expect(
      classifyProviderError(
        new ProviderHttpError({ provider: 'anthropic', status: 400, body: noHeader }),
      ),
    ).toBeNull();
    expect(
      classifyProviderError(
        new ProviderHttpError({ provider: 'anthropic', status: 400, body: otherType }),
      ),
    ).toBeNull();
    // Another status is not this one.
    expect(
      classifyProviderError(new ProviderHttpError({ provider: 'anthropic', status: 401, body }))
        ?.code,
    ).toBe('auth');
  });

  it('says the sentence through publicProviderErrorMessage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const text = publicProviderErrorMessage(
        new ProviderHttpError({ provider: 'anthropic', status: 400, body }),
        'test',
      );
      expect(text).toContain('This Anthropic key is not tied to a workspace.');
      expect(text).not.toContain('invalid_request_error');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the catch helpers: publicErrorText and errorDetail (A10 lows item 4)', () => {
  const SECRET = 'sk-ant-api03-0123456789abcdef org=acme-private';
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a provider's HTTP failure: the sentence out, the detail on the owner's trace", () => {
    const e = new ProviderHttpError({ provider: 'openai', status: 500, body: SECRET });
    const meta: Record<string, unknown>[] = [];
    const text = publicErrorText(e, 'tool x', { setMeta: (m) => meta.push(m) });
    expect(text).toBe('The provider has a server problem. (openai, HTTP 500)');
    // The owner's detail, its key looking literal masked (fix round 1, M1).
    expect(meta).toEqual([
      { error_detail: 'openai call 500: sk-[masked] org=acme-private' },
    ]);
  });

  it('a refused key: the trace names provider and status only', () => {
    const e = new ProviderHttpError({ provider: 'anthropic', status: 401, body: SECRET });
    expect(errorDetail(e)).toBe('anthropic refused the key (HTTP 401)');
    const meta: Record<string, unknown>[] = [];
    publicErrorText(e, 't', { setMeta: (m) => meta.push(m) });
    expect(JSON.stringify(meta)).not.toContain('acme-private');
  });

  it('our own errors keep their text and leave the trace alone', () => {
    const meta: Record<string, unknown>[] = [];
    const step = { setMeta: (m: Record<string, unknown>) => meta.push(m) };
    expect(publicErrorText(new Error('page not found: abc'), 't', step)).toBe(
      'page not found: abc',
    );
    expect(publicErrorText(new InputError('bad date'), 't', step)).toBe('bad date');
    expect(meta).toEqual([]);
    // A 401 of our own (a Graph token) reads as a refused key since fix
    // round 1 (M1: the refusal is read on every error): a line of detail
    // lost, never a key.
    const graph = Object.assign(new Error('no valid access token'), { status: 401 });
    expect(errorDetail(graph)).toBe('provider refused the key (HTTP 401)');
    expect(errorDetail(new Error('page not found: abc'))).toBe('page not found: abc');
  });

  describe("a refused key in a copied adapter message (fix round 1, M1)", () => {
    const KEY = 'sk-proj-AbCdEf0123456789xyz';
    const cases: [string, Error][] = [
      [
        'embeddings failed: 401',
        new Error(`openai embeddings failed: 401 Unauthorized - {"error":"bad key ${KEY}"}`),
      ],
      [
        'chat 401',
        new Error(`openai chat 401: Incorrect API key provided: ${KEY}. You can find yours.`),
      ],
      ['chat 403', new Error(`anthropic chat 403: {"error":"key ${KEY} is disabled"}`)],
      [
        'wrapped',
        new Error('summarize failed', {
          cause: new Error(`openai chat 401: Incorrect API key provided: ${KEY}`),
        }),
      ],
      [
        'openrouter prose',
        new Error(`openrouter-chat 401 on some/model: No auth credentials found ${KEY}`),
      ],
    ];
    for (const [name, e] of cases) {
      it(`${name}: the detail names the status only`, () => {
        expect(errorDetail(e)).toMatch(/^provider refused the key \(HTTP 40[13]\)$/);
        const meta: Record<string, unknown>[] = [];
        publicProviderErrorMessage(e, 't', { setMeta: (m) => meta.push(m) });
        expect(JSON.stringify(meta)).not.toContain(KEY);
        expect(JSON.stringify(meta)).not.toContain('AbCdEf');
      });
    }
  });

  it('masks a key looking literal under any other status (the backstop)', () => {
    const e = new Error(
      'openai chat 400: header Authorization: Bearer sk-proj-AbCdEf0123456789 invalid; ' +
        'api_key=AIzaSyA0123456789abcdefghij token: mtlk_0123456789abcdef hf_abcdefghijklmnop0123',
    );
    const detail = errorDetail(e);
    for (const leak of ['AbCdEf0123', 'SyA0123', '0123456789abcdef', 'abcdefghijklmnop']) {
      expect(detail).not.toContain(leak);
    }
    expect(detail).toContain('openai chat 400');
    expect(maskKeyLiterals('task-1234567 disk-usage risk-free')).toBe(
      'task-1234567 disk-usage risk-free',
    );
    expect(maskKeyLiterals('duplicate key value violates unique constraint')).toBe(
      'duplicate key value violates unique constraint',
    );
  });
});

describe('the watch maps a caught provider failure (A10 lows item 4)', () => {
  const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a reply that repeats its text says the sentence', async () => {
    const e = new ProviderHttpError({ provider: 'openai', status: 413, body: SECRET });
    const w = await watchDatabaseErrors(async () => `could not index: ${errorMessage(e)}`);
    expect(publicToolError(w.value, w.texts, 't', w.errors)).toBe(
      `${PROVIDER_REQUEST_REASONS.too_long} (openai, HTTP 413)`,
    );
  });

  it('a throw of our own that repeats its text goes on as the sentence', async () => {
    const e = new ProviderHttpError({ provider: 'openai', status: 500, body: SECRET });
    const err = await watchDatabaseErrors(async () => {
      throw new Error(`step 2: ${errorMessage(e)}`);
    }).catch((x: unknown) => x);
    expect((err as Error).message).toBe('The provider has a server problem. (openai, HTTP 500)');
  });

  it('the provider error itself, rethrown, goes on as itself (its own mappers)', async () => {
    const e = new ProviderHttpError({ provider: 'openai', status: 500, body: SECRET });
    const err = await watchDatabaseErrors(async () => {
      errorMessage(e);
      throw e;
    }).catch((x: unknown) => x);
    expect(err).toBe(e);
  });
});
