/**
 * Retry/backoff for the chat dispatch path.
 *
 * The native-fetch chat adapters (anthropic / google / xai / huggingface /
 * deepseek) were each a single `fetch` that threw on the first non-OK
 * response — so a momentary 429 or 503 on ANY tool-loop iteration aborted the
 * whole turn (the responder dropped the inbound message; a multi-iteration
 * tool run lost all prior work). Only OpenRouter had resilience, via its SDK's
 * built-in retries.
 *
 * `withChatRetry` wraps a ChatDispatcher so the direct-provider adapters get
 * uniform, configurable retry on transient errors (429, 408/409/425, 5xx,
 * network blips, and the adapters' own 60s fetch timeout) with exponential
 * backoff + jitter, honoring `Retry-After` when the provider sends it. It is
 * applied once at the `getChatAdapter` registry boundary, so every chat call
 * site (responder, web assistant, extractor, summarizer, reflector,
 * heartbeats, invoke_agent) is covered without opting in.
 *
 * OpenRouter is intentionally NOT wrapped — its SDK already retries, and
 * double-wrapping would compound attempt counts. See registry.getChatAdapter.
 */
import type { ChatDispatcher, ChatOptions, ChatResult } from './types';

/** Default attempts AFTER the first try (so 2 ⇒ up to 3 total calls). */
export const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
/** Cap an honored Retry-After so a pathological header can't stall a turn. */
const RETRY_AFTER_CAP_MS = 30_000;

/** Transient HTTP statuses worth retrying. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Structured error the native-fetch chat adapters throw on a non-OK response.
 * Carries the status + parsed Retry-After so the retry wrapper can decide
 * cleanly (no message parsing). The `message` is byte-identical to the plain
 * `Error` the adapters threw before (`<provider> chat <status>: <body…>`), so
 * existing wire-shape tests and log scrapers are unaffected.
 */
export class ChatHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly body?: string;
  constructor(opts: {
    provider: string;
    status: number;
    body?: string;
    retryAfterMs?: number;
  }) {
    super(`${opts.provider} chat ${opts.status}: ${(opts.body ?? '').slice(0, 400)}`);
    this.name = 'ChatHttpError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

/**
 * Parse a `Retry-After` header (RFC 7231: delta-seconds or HTTP-date) into ms.
 * Returns undefined when absent/unparseable.
 */
export function parseRetryAfterMs(headers?: Headers | null): number | undefined {
  // Defensive `?.get?.` — real `fetch` always gives a Headers, but tests (and
  // some mocked transports) hand back a plain object with no headers.
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Decide whether an adapter error is worth retrying, and after how long. */
export function classifyChatError(err: unknown): {
  retry: boolean;
  retryAfterMs?: number;
} {
  if (err instanceof ChatHttpError) {
    return { retry: RETRYABLE_STATUS.has(err.status), retryAfterMs: err.retryAfterMs };
  }
  // Defensive: any error exposing a numeric HTTP status (e.g. an SDK error).
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return { retry: RETRYABLE_STATUS.has(status) };
  // The adapters' own `AbortSignal.timeout(60_000)` fires a TimeoutError;
  // a bare AbortError here is likewise the timeout (ChatOptions has no
  // caller-supplied signal). Both are transient — retry.
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return { retry: true };
  // Raw fetch network failures surface as TypeError ("fetch failed", ECONNRESET,
  // DNS, …). The wrapper only guards a network call, so this is a blip — retry.
  if (err instanceof TypeError) return { retry: true };
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
    return { retry: true };
  }
  return { retry: false };
}

function describeError(err: unknown): string {
  if (err instanceof ChatHttpError) return `HTTP ${err.status}`;
  const name = (err as { name?: string } | null)?.name;
  return name && name !== 'Error' ? name : 'network error';
}

export interface ChatRetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Wrap a ChatDispatcher with retry/backoff on its `chat` call. Per-call
 * `opts.maxRetries` overrides the config default; 0 disables. All other
 * dispatcher members (providerId, adapterName, discoverModels, staticCatalog)
 * are preserved unchanged.
 */
export function withChatRetry(
  adapter: ChatDispatcher,
  config: ChatRetryConfig = {},
): ChatDispatcher {
  const base = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const chat = async (opts: ChatOptions): Promise<ChatResult> => {
    const maxRetries = opts.maxRetries ?? config.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;
    for (;;) {
      try {
        return await adapter.chat(opts);
      } catch (err) {
        const { retry, retryAfterMs } = classifyChatError(err);
        if (!retry || attempt >= maxRetries) throw err;
        attempt += 1;
        const delay =
          retryAfterMs != null
            ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
            : Math.round(Math.random() * Math.min(max, base * 2 ** (attempt - 1)));
        console.warn(
          `[chat-retry] ${adapter.adapterName} ${opts.model}: ${describeError(err)} — retry ${attempt}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
  return { ...adapter, chat };
}
