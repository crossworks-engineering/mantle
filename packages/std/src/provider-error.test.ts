import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domainErrorAnswer } from './domain-errors';
import { InputError, errorMessage, publicProviderErrorMessage, toolThrowText } from './index';
import {
  ProviderHttpError,
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
    [400, 'prompt is too long for this route'],
    [403, 'Your input was flagged by moderation'],
    [413, 'Request entity too large'],
  ])('an OpenRouter %i says the fixed sentence and its status, never the body', (status, up) => {
    const e = sdkError(status, up);
    expect(classifyProviderError(e)).toBeNull();
    const text = publicProviderErrorMessage(e, 'team-turn');
    expect(text).toBe(`The model provider answered with an error. (HTTP ${status})`);
    expect(text).not.toContain('acme-private');
    expect(text).not.toContain(up);
    // The detail is in the server log.
    expect(JSON.stringify(logged.map((a) => String(a[1])))).toContain('acme-private');
  });

  it("the SDK's own error, unwrapped (a research tool), is the same", () => {
    const e = Object.assign(new Error(`API error occurred: ${SECRET}`), {
      statusCode: 413,
      body: SECRET,
    });
    expect(publicProviderErrorMessage(e, 'search')).toBe(
      'The model provider answered with an error. (HTTP 413)',
    );
  });

  it('a body that did not parse says the fixed sentence (V8 quotes the body)', () => {
    let parseError: unknown;
    try {
      JSON.parse(`<html>${SECRET}</html>`);
    } catch (e) {
      parseError = e;
    }
    const text = publicProviderErrorMessage(parseError, 'test');
    expect(text).toBe('The model provider answered with an error.');
  });
});

describe('toolThrowText: a builtin that throws (A10 #10 fix round 2)', () => {
  const text = (e: unknown, where = 't') => toolThrowText(e, where) ?? errorMessage(e);
  const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

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
    expect(text(e, 'tool x')).toBe('The model provider answered with an error. (HTTP 400)');
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
