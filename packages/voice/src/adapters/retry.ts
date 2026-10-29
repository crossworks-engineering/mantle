/**
 * Retry/backoff for the chat dispatch path.
 *
 * The native-fetch chat adapters (anthropic / google / xai / huggingface /
 * deepseek / ...) were each a single `fetch` that threw on the first non-OK
 * response, so a momentary 429 or 503 on ANY tool-loop iteration aborted the
 * whole turn. Only OpenRouter had resilience, via its SDK's built-in retries.
 *
 * `withChatRetry` wraps a ChatDispatcher so the direct-provider adapters get
 * uniform retry on transient errors (429, 408/409/425, 5xx, network blips,
 * and the adapters' own deadline) with exponential backoff and full jitter,
 * honouring `Retry-After` when the provider sends it. `getChatAdapter`
 * (./registry.ts) applies it once, so every chat call site (responder, web
 * assistant, extractor, summarizer, reflector, heartbeats, invoke_agent) is
 * covered without opting in. OpenRouter is NOT wrapped: its SDK already
 * retries, and double-wrapping would compound attempt counts.
 *
 * The loop is @mantle/std withRetry, the retry rule is std's retryDecision
 * and the error is std's ProviderHttpError (500 ms base, 8 s cap, 2
 * retries, Retry-After capped at 30 s; pinned in retry.test.ts). It lives
 * here, not in @mantle/voice-client: that is a published zero-dependency
 * contract package that may not import std.
 */
import {
  ProviderHttpError,
  backoffMs,
  isEmptyJsonBodyError,
  parseRetryAfterMs,
  retryDecision,
  withRetry,
} from '@mantle/std';
import type { ChatDispatcher, ChatOptions, ChatResult, ChatStreamSink } from './types';

export { isEmptyJsonBodyError, parseRetryAfterMs };

/** Default attempts AFTER the first try (so 2 means up to 3 total calls). */
export const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
/** Cap an honoured Retry-After so a pathological header cannot stall a turn. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * The error the native-fetch chat adapters throw on a non-OK response: THE
 * ProviderHttpError, with the chat message (`<provider> chat <status>:
 * <body...>`, byte-identical to before, so wire-shape tests and log scrapers
 * are unaffected).
 */
export class ChatHttpError extends ProviderHttpError {
  constructor(opts: { provider: string; status: number; body?: string; retryAfterMs?: number }) {
    super({ ...opts, what: 'chat' });
    this.name = 'ChatHttpError';
  }
}

/** Decide whether an adapter error is worth retrying, and after how long
 *  (@mantle/std retryDecision). */
export const classifyChatError = retryDecision;

function describeError(err: unknown): string {
  if (err instanceof ProviderHttpError) return `HTTP ${err.status}`;
  if (isEmptyJsonBodyError(err)) return 'empty/truncated response';
  const name = (err as { name?: string } | null)?.name;
  return name && name !== 'Error' ? name : 'network error';
}

export interface ChatRetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** One attempt loop shared by the one-shot and streaming wrappers. `mayRetry`
 *  lets the streaming path veto a replay once output reached the user. */
function attemptWithRetry<T>(
  adapter: ChatDispatcher,
  opts: ChatOptions,
  config: ChatRetryConfig,
  run: () => Promise<T>,
  mayRetry: () => boolean,
): Promise<T> {
  const baseMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retries = opts.maxRetries ?? config.maxRetries ?? DEFAULT_MAX_RETRIES;
  return withRetry(run, {
    retries,
    // A caller-aborted signal (user Stop) is not transient: every retry would
    // abort identically after a pointless backoff sleep. Surface it at once;
    // the tool loop and run-turn recognise the stop.
    retryOn: (f) => !opts.signal?.aborted && mayRetry() && retryDecision(f.error).retry,
    delayMs: (retry, f) => {
      const { retryAfterMs } = retryDecision(f.error);
      return retryAfterMs != null
        ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
        : backoffMs(retry - 1, { baseMs, maxMs, jitter: 'full' });
    },
    onRetry: ({ retry, delayMs, failure }) => {
      console.warn(
        `[chat-retry] ${adapter.adapterName} ${opts.model}: ${describeError(failure.error)}, retry ${retry}/${retries} in ${delayMs}ms`,
      );
    },
  });
}

/**
 * Wrap a ChatDispatcher with retry/backoff on its `chat` AND `chatStream`
 * calls. Per-call `opts.maxRetries` overrides the config default; 0 disables.
 * All other dispatcher members (providerId, adapterName, discoverModels,
 * staticCatalog) are preserved unchanged.
 *
 * Streaming is retried only while nothing has reached the user yet: a 429, a
 * 5xx, a network blip or a connect timeout before the first delta re-sends the
 * request exactly like the one-shot path. Once a delta has been emitted the
 * error surfaces as-is: replaying would repeat text the client already
 * rendered, and the adapters already return the partial on a user Stop.
 */
export function withChatRetry(
  adapter: ChatDispatcher,
  config: ChatRetryConfig = {},
): ChatDispatcher {
  const chat = (opts: ChatOptions): Promise<ChatResult> =>
    attemptWithRetry(
      adapter,
      opts,
      config,
      () => adapter.chat(opts),
      () => true,
    );
  const inner = adapter.chatStream?.bind(adapter);
  const chatStream = inner
    ? (opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> => {
        let emitted = false;
        const sink: ChatStreamSink = (delta) => {
          emitted = true;
          onDelta(delta);
        };
        return attemptWithRetry(
          adapter,
          opts,
          config,
          () => inner(opts, sink),
          () => !emitted,
        );
      }
    : undefined;
  return { ...adapter, chat, ...(chatStream ? { chatStream } : {}) };
}
