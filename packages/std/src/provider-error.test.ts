import { describe, expect, it } from 'vitest';
import { domainErrorAnswer } from './domain-errors';
import { publicProviderErrorMessage } from './index';
import {
  ProviderHttpError,
  classifyProviderError,
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
