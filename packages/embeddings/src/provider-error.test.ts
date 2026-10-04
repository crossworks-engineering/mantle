import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ERROR_REASONS,
  classifyProviderError,
  isAccountError,
  providerErrorStatus,
} from './provider-error';

/** The error the OpenAI embedding adapter threw on both brains (2026-10-04). */
const noCredits = () =>
  new Error(
    'OpenAI embeddings failed: 429 Too Many Requests — {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
  );

/** A chat adapter's structured error. */
const chatErr = (status: number, body = '') =>
  Object.assign(new Error(`openrouter chat ${status}: ${body}`), {
    name: 'ChatHttpError',
    status,
    body,
  });

describe('classifyProviderError', () => {
  it('reads a 429 insufficient_quota as a permanent account error, not a rate limit', () => {
    const c = classifyProviderError(noCredits());
    expect(c).toMatchObject({ code: 'quota', permanent: true, status: 429 });
    expect(c?.reason).toBe(PROVIDER_ERROR_REASONS.quota);
  });

  it('reads a plain 429 as a transient rate limit', () => {
    expect(
      classifyProviderError(
        new Error('OpenRouter embeddings failed: 429 Too Many Requests — slow down'),
      ),
    ).toMatchObject({ code: 'rate_limit', permanent: false });
    expect(classifyProviderError(chatErr(429, 'Rate limit exceeded'))).toMatchObject({
      code: 'rate_limit',
    });
  });

  it('reads 402 and a "no credits" body as quota', () => {
    expect(classifyProviderError(chatErr(402, 'Insufficient credits'))?.code).toBe('quota');
    expect(classifyProviderError(chatErr(403, 'Key limit exceeded: out of credits'))?.code).toBe(
      'quota',
    );
  });

  it('reads 401 and a plain 403 as a refused key', () => {
    expect(classifyProviderError(chatErr(401, 'invalid api key'))).toMatchObject({
      code: 'auth',
      permanent: true,
    });
    expect(classifyProviderError(chatErr(403, 'forbidden'))?.code).toBe('auth');
  });

  it('a 403 for flagged input says nothing about the account', () => {
    expect(classifyProviderError(chatErr(403, 'Your input was flagged by moderation'))).toBeNull();
  });

  it('reads 404, and a 400 about the model, as an unknown model', () => {
    expect(classifyProviderError(chatErr(404, 'No endpoints found for x/y'))?.code).toBe('model');
    expect(
      classifyProviderError(
        new Error(
          'OpenAI embeddings failed: 400 Bad Request — The model `text-embedding-9` does not exist',
        ),
      ),
    ).toMatchObject({ code: 'model', permanent: true });
  });

  it('a 400 about the input is not a provider problem', () => {
    expect(
      classifyProviderError(
        new Error(
          'OpenAI embeddings failed: 400 Bad Request — maximum context length is 8192 tokens',
        ),
      ),
    ).toBeNull();
  });

  it('reads 5xx, network failures and timeouts as transient', () => {
    expect(classifyProviderError(chatErr(503, 'overloaded'))).toMatchObject({
      code: 'server',
      permanent: false,
    });
    expect(classifyProviderError(new TypeError('fetch failed'))?.code).toBe('network');
    expect(classifyProviderError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))?.code).toBe(
      'network',
    );
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    expect(classifyProviderError(timeout)?.code).toBe('timeout');
  });

  it('reads our own "no api key" throws as a permanent config error', () => {
    expect(
      classifyProviderError(
        new Error("embed: no api key for provider 'openai'. Add one at /settings/keys"),
      ),
    ).toMatchObject({ code: 'no_key', permanent: true });
  });

  it('never returns provider text as the reason', () => {
    const c = classifyProviderError(chatErr(401, 'org-SECRET123 key sk-abc...xyz is invalid'));
    expect(c?.reason).not.toMatch(/SECRET|sk-/);
  });

  it('returns null for a non-provider error', () => {
    expect(
      classifyProviderError(new Error('duplicate key value violates unique constraint')),
    ).toBeNull();
    expect(classifyProviderError(null)).toBeNull();
  });

  it('does not read a stray three-digit number as a status', () => {
    expect(providerErrorStatus(new Error('expected 768 dimensions, got 1536'))).toBeUndefined();
  });
});

describe('isAccountError', () => {
  it('is true only for permanent classes', () => {
    expect(isAccountError(noCredits())).toBe(true);
    expect(isAccountError(chatErr(401))).toBe(true);
    expect(isAccountError(chatErr(429, 'slow down'))).toBe(false);
    expect(isAccountError(chatErr(500))).toBe(false);
    expect(isAccountError(new Error('anything'))).toBe(false);
  });
});
